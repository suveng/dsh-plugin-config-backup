/**
 * Backup engine shared by the scheduled tick, the Remote methods the Web
 * sidebar calls, and the agent tool.
 *
 * One backup is a directory `<targetDir>/<YYYYMMDD-HHmmss>` holding a copy of
 * the allow-listed configuration roots of `$DSH_HOME`; `node_modules` and the
 * backup directory itself are never copied. Retention then deletes the oldest
 * snapshots beyond `keepCount`.
 * @module dsh-plugin-config-backup/engine
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'

/** Files of the configuration root worth restoring; anything else is skipped. */
export const CONFIG_FILES = Object.freeze([
  'AGENTS.md',
  'settings.yaml',
  'cordis.patch.yml',
  'cordis.yml',
  '.env',
  '.credentials.yaml',
  '.npmrc',
  'README.md',
  'USER.md',
  'MEMORY.md',
])

/** Directories of the configuration root copied recursively. */
export const CONFIG_DIRS = Object.freeze([
  'skills',
  'storages',
  'presets',
  'commands',
  'agents',
  'mcp',
  'prompts',
  'templates',
])

/** Never copied, at any depth. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', '.pnpm-store'])
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/** A snapshot directory name: `YYYYMMDD-HHmmss`, or the same with a `-N` collision suffix. */
const SNAPSHOT_NAME = /^\d{8}-\d{6}(-\d+)?$/

/**
 * @typedef {'auto' | 'manual' | 'agent' | 'pre-restore'} BackupKind
 * @typedef {object} BackupEntry
 * @property {string} id Snapshot directory name; the stable identity of one backup.
 * @property {string} path Absolute path of the snapshot directory.
 * @property {number} createdAt Epoch milliseconds of the snapshot timestamp.
 * @property {number} files Number of files copied.
 * @property {number} bytes Total bytes copied.
 * @property {string} kind Who asked for this backup.
 * @property {number} errors Entries skipped because they could not be read.
 * @typedef {object} Retention
 * @property {string[]} removed Snapshot ids deleted because they fell out of the retention window.
 * @property {string[]} failed Paths that could not be deleted.
 */

/**
 * Two-digit zero padding.
 * @param {number} value - small non-negative integer.
 * @returns {string} the padded decimal.
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Format one date as a snapshot directory name in local time.
 * @param {Date} date - instant to name.
 * @returns {string} `YYYYMMDD-HHmmss`.
 */
export function snapshotName(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

/**
 * Parse a snapshot directory name back to its instant.
 * @param {string} name - candidate directory name.
 * @returns {number | undefined} epoch milliseconds, or undefined when the name is not a snapshot.
 */
export function snapshotTime(name) {
  if (!SNAPSHOT_NAME.test(name)) return undefined
  const [day, clock] = name.split('-')
  const date = new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)),
    Number(clock.slice(0, 2)),
    Number(clock.slice(2, 4)),
    Number(clock.slice(4, 6)),
  )
  const value = date.getTime()
  return Number.isFinite(value) ? value : undefined
}

/**
 * Human-readable byte size.
 * @param {number} bytes - byte count.
 * @returns {string} e.g. `12.4 MB`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/**
 * Read the modification time of a file, or 0 when it does not exist.
 * @param {string} file - absolute path.
 * @returns {Promise<number>} epoch milliseconds.
 */
async function mtimeOf(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Copy one file, creating its parent directory.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @returns {Promise<number>} bytes copied.
 */
async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return (await fs.stat(to)).size
}

/**
 * Copy one directory tree, skipping ignored names and following symbolic links
 * to regular files while refusing link cycles through `seen`.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 * @param {{files: number, bytes: number, errors: number, skip: ReadonlySet<string>}} stats - running counters.
 * @param {Set<string>} seen - real paths of directories already entered.
 */
async function copyTree(from, to, stats, seen) {
  let real
  try {
    real = await fs.realpath(from)
  } catch {
    stats.errors += 1
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try {
    entries = await fs.readdir(from, { withFileTypes: true })
  } catch {
    stats.errors += 1
    return
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name) || IGNORED_FILES.has(entry.name)) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (stats.skip.has(path.resolve(source))) continue
    if (entry.isSymbolicLink()) {
      try {
        const link = await fs.realpath(source)
        const linkStat = await fs.stat(link)
        if (linkStat.isDirectory()) await copyTree(source, target, stats, seen)
        else if (linkStat.isFile()) {
          stats.bytes += await copyFile(link, target)
          stats.files += 1
        }
      } catch {
        stats.errors += 1
      }
      continue
    }
    if (entry.isDirectory()) {
      await copyTree(source, target, stats, seen)
      continue
    }
    if (!entry.isFile()) continue
    try {
      stats.bytes += await copyFile(source, target)
      stats.files += 1
    } catch {
      stats.errors += 1
    }
  }
}

/**
 * List the snapshots of one backup directory, newest first.
 * @param {string} root - backup directory.
 * @returns {Promise<Array<{id: string, path: string, createdAt: number, bytes: number, kind: string}>>} snapshots.
 */
export async function listSnapshots(root) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const createdAt = snapshotTime(entry.name)
    if (createdAt === undefined) continue
    const dir = path.join(root, entry.name)
    let bytes = 0
    let kind = ''
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, '.backup.json'), 'utf8'))
      if (typeof meta?.bytes === 'number') bytes = meta.bytes
      if (typeof meta?.kind === 'string') kind = meta.kind
    } catch {
      bytes = await directorySize(dir)
    }
    rows.push({ id: entry.name, path: dir, createdAt, bytes, kind })
  }
  rows.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? 1 : -1))
  return rows
}

/**
 * Sum the size of every regular file under one directory.
 * @param {string} dir - directory to measure.
 * @returns {Promise<number>} total bytes.
 */
async function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(target)
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(target)).size
      } catch {
        // A file removed mid-scan contributes nothing.
      }
    }
  }
  return total
}

/**
 * Everything one scheduled or manual backup needs.
 * @typedef {object} BackupOptions
 * @property {string} home Harness configuration root (`$DSH_HOME`).
 * @property {string} targetDir Root directory that holds every snapshot.
 * @property {number} keepCount How many snapshots to keep.
 * @property {readonly string[]} include Extra paths (absolute, or relative to `home`) to copy.
 * @property {readonly string[]} exclude Paths (absolute, or relative to `home`) to skip.
 * @property {BackupKind} kind Who asked for this backup.
 */

/**
 * Create one snapshot and apply retention.
 * @param {BackupOptions} options - resolved backup settings.
 * @returns {Promise<{entry: BackupEntry, retention: Retention}>} the created snapshot and the retention outcome.
 */
export async function runBackup(options) {
  const home = path.resolve(options.home)
  const targetDir = path.resolve(options.targetDir)
  const startedAt = Date.now()
  const stamp = new Date(startedAt)
  await fs.mkdir(targetDir, { recursive: true })
  const skip = new Set([targetDir, `${targetDir}.tmp`, `${targetDir}.failed`])
  for (const item of options.exclude ?? []) skip.add(path.resolve(home, item))
  const seen = new Set()
  const stats = { files: 0, bytes: 0, errors: 0, skip }

  let latestSourceMtime = 0
  let id = snapshotName(stamp)
  let attempt = 0
  while (await fs.stat(path.join(targetDir, id)).then(() => true).catch(() => false)) {
    attempt += 1
    id = `${snapshotName(stamp)}-${attempt}`
  }
  const stage = async (candidate) => {
    const target = path.join(targetDir, candidate)
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })
    stats.files = 0
    stats.bytes = 0
    stats.errors = 0
    seen.clear()
    for (const file of CONFIG_FILES) {
      const source = path.join(home, file)
      if (skip.has(source)) continue
      try {
        const info = await fs.lstat(source)
        if (!info.isFile()) continue
        latestSourceMtime = Math.max(latestSourceMtime, info.mtimeMs)
        stats.bytes += await copyFile(source, path.join(target, file))
        stats.files += 1
      } catch (error) {
        if (error?.code !== 'ENOENT') stats.errors += 1
      }
    }
    for (const name of CONFIG_DIRS) {
      const source = path.join(home, name)
      if (skip.has(source)) continue
      let info
      try {
        info = await fs.stat(source)
      } catch {
        continue
      }
      if (!info.isDirectory()) continue
      latestSourceMtime = Math.max(latestSourceMtime, info.mtimeMs)
      await copyTree(source, path.join(target, name), stats, seen)
    }
    for (const item of options.include ?? []) {
      const source = path.resolve(home, item)
      if (skip.has(source)) continue
      let info
      try {
        info = await fs.stat(source)
      } catch {
        continue
      }
      latestSourceMtime = Math.max(latestSourceMtime, info.mtimeMs)
      if (info.isDirectory()) await copyTree(source, path.join(target, path.relative(home, source)), stats, seen)
      else if (info.isFile()) {
        stats.bytes += await copyFile(source, path.join(target, path.relative(home, source)))
        stats.files += 1
      }
    }
    return target
  }
  let staging
  try {
    staging = await stage(id)
  } catch {
    attempt += 1
    id = `${snapshotName(stamp)}-${attempt}`
    staging = await stage(id)
  }

  const entry = {
    id,
    path: staging,
    createdAt: latestSourceMtime > 0 ? Math.round(latestSourceMtime) : startedAt,
    files: stats.files,
    bytes: stats.bytes,
    kind: options.kind,
    errors: stats.errors,
  }
  await writeMeta(staging, entry, { host: os.hostname(), home, startedAt, finishedAt: Date.now() })
  const retention = await pruneSnapshots(targetDir, options.keepCount, id)
  return { entry, retention }
}

/**
 * Persist the manifest a backup directory carries.
 * @param {string} dir - snapshot directory.
 * @param {BackupEntry} entry - the entry as reported to callers.
 * @param {object} extra - host, home, and both timestamps.
 * @returns {Promise<void>} settles when the manifest is written.
 */
async function writeMeta(dir, entry, extra) {
  const meta = {
    id: entry.id,
    kind: entry.kind,
    files: entry.files,
    bytes: entry.bytes,
    errors: entry.errors,
    createdAt: new Date(entry.createdAt).toISOString(),
    ...extra,
    home: extra.home,
    host: extra.host,
    startedAt: new Date(extra.startedAt).toISOString(),
    finishedAt: new Date(extra.finishedAt).toISOString(),
  }
  await fs.writeFile(path.join(dir, '.backup.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/**
 * Delete snapshots beyond the newest `keepCount`, never the one just created.
 * @param {string} root - backup directory.
 * @param {number} keepCount - snapshots to keep; 0 or less disables retention.
 * @param {string} [keepId] - snapshot that must survive this pass.
 * @returns {Promise<Retention>} removed ids and failed paths.
 */
export async function pruneSnapshots(root, keepCount, keepId) {
  const removed = []
  const failed = []
  if (!Number.isFinite(keepCount) || keepCount <= 0) return { removed, failed }
  const rows = await listSnapshots(root)
  const kept = rows.filter(row => row.id === keepId)
  const rest = rows.filter(row => row.id !== keepId)
  const survivors = rest.slice(0, Math.max(0, keepCount - kept.length))
  for (const row of rest.slice(survivors.length)) {
    try {
      await fs.rm(row.path, { recursive: true, force: true })
      removed.push(row.id)
    } catch {
      failed.push(row.path)
    }
  }
  return { removed, failed }
}

/**
 * Delete one snapshot by id.
 * @param {string} root - backup directory.
 * @param {string} id - snapshot directory name.
 * @returns {Promise<boolean>} whether a snapshot of that id existed.
 * @throws {Error} when the id is not a snapshot name.
 */
export async function removeSnapshot(root, id) {
  if (!SNAPSHOT_NAME.test(id)) throw new Error(`not a backup id: ${JSON.stringify(id)}`)
  const dir = path.join(root, id)
  const exists = await fs.stat(dir).then(info => info.isDirectory()).catch(() => false)
  if (!exists) return false
  await fs.rm(dir, { recursive: true, force: true })
  return true
}

/**
 * Read the latest snapshot's manifest, if any.
 * @param {string} root - backup directory.
 * @returns {Promise<object | undefined>} the manifest object.
 */
export async function readLatestMeta(root) {
  const rows = await listSnapshots(root)
  const latest = rows[0]
  if (latest === undefined) return undefined
  try {
    return JSON.parse(await fs.readFile(path.join(latest.path, '.backup.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read the mtime of one path, tolerating absence.
 * @param {string} file - absolute path.
 * @returns {Promise<number>} epoch milliseconds, 0 when absent.
 */
export { mtimeOf }

/**
 * A snapshot as one archive, so it can travel to another machine.
 * @typedef {object} SnapshotArchive
 * @property {string} file Absolute path of the `.tar.gz`.
 * @property {string} name File name of the archive.
 * @property {string} id Snapshot id inside the archive.
 * @property {string} sha256 Hex digest of the archive; changes are detectable on the other side.
 * @property {number} bytes Archive size.
 */

/**
 * Stream one directory as `<name>` entries of a gzip-compressed tar archive
 * written in ustar format. Hand-rolled because the Host runs without a tar
 * dependency: only regular files, directories, and symbolic links (stored as
 * link names) are emitted, which is all a configuration snapshot contains.
 * @param {string} root - directory to archive.
 * @param {string} name - entry prefix, i.e. the snapshot id.
 * @param {string} file - archive to write.
 * @returns {Promise<number>} archive size in bytes.
 */
async function writeTarGz(root, name, file) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const gzip = createGzip({ level: 6 })
  const output = createWriteStream(file)
  const finished = pipeline(gzip, output)
  const header = (entryName, size, type, link) => {
    const block = Buffer.alloc(512)
    block.write(entryName, 0, 100, 'utf8')
    block.write('000644 ', 100, 8)
    block.write('000000 ', 108, 8)
    block.write('000000 ', 116, 8)
    block.write(`${size.toString(8).padStart(11, '0')} `, 124, 12)
    block.write('00000000000 ', 136, 12)
    block.write('        ', 148, 8)
    block.write(type, 156, 1)
    if (link !== undefined) block.write(link, 157, 100, 'utf8')
    block.write('ustar\x0000', 257, 8)
    block.write('dsh-config-backup', 265, 32)
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    return block
  }
  const push = async chunk => {
    if (!gzip.write(chunk)) await new Promise(resolve => gzip.once('drain', resolve))
  }
  const pad = async size => {
    const rest = size % 512
    if (rest !== 0) await push(Buffer.alloc(512 - rest))
  }
  const walk = async (dir, prefix) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const full = path.join(dir, entry.name)
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (Buffer.byteLength(rel) > 99) continue
      const info = await fs.lstat(full)
      if (info.isSymbolicLink()) {
        const link = await fs.readlink(full)
        if (Buffer.byteLength(link) > 99) continue
        await push(header(rel, 0, '2', link))
      } else if (info.isDirectory()) {
        await push(header(`${rel}/`, 0, '5'))
        await walk(full, rel)
      } else if (info.isFile()) {
        await push(header(rel, info.size, '0'))
        let written = 0
        for await (const chunk of createReadStream(full)) {
          written += chunk.length
          await push(chunk)
        }
        // A file that grew while being read must not shift the following headers.
        if (written !== info.size) throw new Error(`file changed while archiving: ${full}`)
        await pad(info.size)
      }
    }
  }
  try {
    await walk(root, name)
    await push(Buffer.alloc(1024))
  } finally {
    gzip.end()
  }
  await finished
  return (await fs.stat(file)).size
}

/**
 * @param {string} file - path to digest.
 * @returns {Promise<string>} hex SHA-256 of the file.
 */
async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Pack one snapshot into a `.tar.gz` an operator can carry to another machine.
 * @param {string} root - backup directory.
 * @param {string} id - snapshot id.
 * @param {string} [outDir] - where to write the archive; defaults to the system temp directory.
 * @returns {Promise<SnapshotArchive>} the archive.
 * @throws {Error} when the id is not a snapshot name or no such snapshot exists.
 */
export async function exportSnapshot(root, id, outDir) {
  if (!SNAPSHOT_NAME.test(id)) throw new Error(`not a backup id: ${JSON.stringify(id)}`)
  const dir = path.join(root, id)
  const exists = await fs.stat(dir).then(info => info.isDirectory()).catch(() => false)
  if (!exists) throw new Error(`no backup named ${JSON.stringify(id)}`)
  const target = path.join(outDir ?? os.tmpdir(), `dsh-backup-${id}.tar.gz`)
  const bytes = await writeTarGz(dir, id, target)
  return { file: target, name: path.basename(target), id, sha256: await sha256Of(target), bytes }
}

/**
 * Treat one string as a safe relative path inside an extracted tree.
 * @param {string} name - entry path.
 * @returns {string | undefined} the path, or undefined when it could escape the tree.
 */
function safeEntry(name) {
  const clean = name.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (clean.length === 0) return undefined
  if (clean.startsWith('/') || clean.includes('\0')) return undefined
  const segments = clean.split('/')
  if (segments.some(segment => segment === '..')) return undefined
  return clean
}


/**
 * Read one `ustar` archive into memory, tolerating any block sizes. A pure
 * buffer pass is used rather than a stream because a 13 MB snapshot expands
 * fast and the tar headers must stay aligned while files are written.
 * @param {string} archive - `.tar.gz` file.
 * @param {string} dir - destination directory, created when missing.
 * @returns {Promise<{files: number, bytes: number}>} what was written.
 * @throws {Error} when the archive holds an entry that would escape `dir`.
 */
async function extractTarGz(archive, dir) {
  await fs.mkdir(dir, { recursive: true })
  const raw = await fs.readFile(archive)
  const tar = gunzipSync(raw)
  const root = path.resolve(dir)
  const stats = { files: 0, bytes: 0 }
  let offset = 0
  const text = (from, length) => tar.subarray(from, from + length).toString('utf8').replace(/\0[\s\S]*$/, '')
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every(byte => byte === 0)) break
    const name = safeEntry(text(offset, 100))
    if (name === undefined) throw new Error(`unsafe archive entry: ${JSON.stringify(text(offset, 100))}`)
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(block[156] || 48)
    const link = text(offset + 157, 100)
    const target = path.join(root, name)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`unsafe archive entry: ${JSON.stringify(name)}`)
    }
    offset += 512
    if (type === '5') {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    const padded = Math.ceil(size / 512) * 512
    if (type === '2') {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.symlink(link, target).catch(() => {})
      continue
    }
    if (type === '0' || type === '\0') {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, tar.subarray(offset, offset + size))
      stats.files += 1
      stats.bytes += size
    }
    offset += padded
  }
  return stats
}

/**
 * Read the single snapshot directory an archive holds, extracting it into a
 * scratch directory the caller removes.
 * @param {string} archive - `.tar.gz` made by {@link exportSnapshot}.
 * @returns {Promise<{scratch: string, dir: string, id: string, files: number, bytes: number}>} the extracted snapshot.
 * @throws {Error} when the archive is not a configuration snapshot.
 */
async function unpackSnapshot(archive) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-import-'))
  try {
    const stats = await extractTarGz(archive, scratch)
    const entries = (await fs.readdir(scratch, { withFileTypes: true })).filter(entry => entry.isDirectory())
    if (entries.length !== 1) throw new Error('archive must hold exactly one snapshot directory')
    const id = entries[0].name
    if (!SNAPSHOT_NAME.test(id)) throw new Error(`not a backup id: ${JSON.stringify(id)}`)
    const dir = path.join(scratch, id)
    const known = await fs.stat(path.join(dir, 'AGENTS.md')).catch(() => undefined)
    const patch = await fs.stat(path.join(dir, 'cordis.patch.yml')).catch(() => undefined)
    if (known === undefined && patch === undefined) {
      throw new Error('archive does not look like a dsh configuration snapshot')
    }
    return { scratch, dir, id, files: stats.files, bytes: stats.bytes }
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true })
    throw error
  }
}

/**
 * Copy a directory tree verbatim.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 * @returns {Promise<void>} settles when the copy is complete.
 */
async function copyDirectory(from, to) {
  const stats = { files: 0, bytes: 0, errors: 0, skip: new Set() }
  const seen = new Set()
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target, stats, seen)
    else if (entry.isFile()) await copyFile(source, target)
  }
}

/**
 * Bring in one archive as a new snapshot of the local backup directory, keeping
 * the archive's id when it is free and suffixing it otherwise.
 * @param {string} root - local backup directory.
 * @param {string} archive - `.tar.gz` made by {@link exportSnapshot}.
 * @returns {Promise<{entry: BackupEntry, manifest: object | undefined}>} the imported snapshot and the manifest it carried.
 * @throws {Error} when the archive is unreadable, foreign, or already imported.
 */
export async function importSnapshot(root, archive) {
  console.error('[probe] importSnapshot enter', typeof root, archive)
  const unpacked = await unpackSnapshot(archive)
  console.error('[probe] unpacked', unpacked.id)
  try {
    let manifest
    try {
      manifest = JSON.parse(await fs.readFile(path.join(unpacked.dir, '.backup.json'), 'utf8'))
    } catch {
      manifest = undefined
    }
    const source = typeof manifest?.sha256 === 'string'
      ? manifest.sha256
      : await sha256Of(archive)
    for (const row of await listSnapshots(root)) {
      const carried = await readManifest(row.path)
      if (carried?.source === undefined) continue
      if (carried.source === source) {
        throw new Error(`this archive is already imported as ${row.id}`)
      }
    }
    await fs.mkdir(root, { recursive: true })
    let id = unpacked.id
    let attempt = 0
    while (await fs.stat(path.join(root, id)).then(() => true).catch(() => false)) {
      attempt += 1
      id = `${unpacked.id}-${attempt}`
    }
    const target = path.join(root, id)
    try {
      await fs.rename(unpacked.dir, target)
    } catch {
      await copyDirectory(unpacked.dir, target)
      await fs.rm(unpacked.dir, { recursive: true, force: true })
    }
    const createdAt = snapshotTime(id.split('-').slice(0, 2).join('-')) ?? Date.now()
    const entry = {
      id,
      path: target,
      createdAt,
      files: typeof manifest?.files === 'number' ? manifest.files : unpacked.files,
      bytes: typeof manifest?.bytes === 'number' ? manifest.bytes : unpacked.bytes,
      kind: 'import',
      errors: 0,
    }
    await writeMeta(target, entry, {
      host: os.hostname(),
      home: typeof manifest?.home === 'string' ? manifest.home : '',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      importedFrom: path.basename(archive),
      source,
    })
    return { entry, manifest }
  } finally {
    await fs.rm(unpacked.scratch, { recursive: true, force: true })
  }
}

/**
 * Read one snapshot's manifest.
 * @param {string} dir - snapshot directory.
 * @returns {Promise<object | undefined>} the manifest, or undefined when absent or malformed.
 */
async function readManifest(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, '.backup.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Copy one file or directory tree, replacing what is at the destination.
 * Symbolic links are copied as links; a broken link is skipped as an error.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @param {{files: number, bytes: number, errors: number}} stats - running counters.
 * @returns {Promise<void>} settles when the entry is in place.
 */
async function restoreEntry(from, to, stats) {
  const info = await fs.lstat(from)
  if (info.isSymbolicLink()) {
    const link = await fs.readlink(from)
    await fs.rm(to, { recursive: true, force: true })
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.symlink(link, to).catch(() => { stats.errors += 1 })
    return
  }
  if (info.isDirectory()) {
    const exists = await fs.lstat(to).then(target => target.isDirectory()).catch(() => false)
    if (!exists) await fs.rm(to, { recursive: true, force: true })
    await fs.mkdir(to, { recursive: true })
    for (const entry of await fs.readdir(from)) {
      await restoreEntry(path.join(from, entry), path.join(to, entry), stats)
    }
    return
  }
  if (!info.isFile()) return
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    const written = path.join(path.dirname(to), `.${path.basename(to)}.dsh-restore-${process.pid}`)
    await fs.copyFile(from, written)
    await fs.rename(written, to)
    stats.files += 1
    stats.bytes += info.size
  } catch {
    stats.errors += 1
  }
}

/**
 * Which path a snapshot entry belongs to in a configuration root: only the
 * allow-listed names (plus anything the snapshot itself carries at the top
 * level) are restored, so a stray file can never land somewhere unexpected.
 * @param {string} top - first path segment inside the snapshot.
 * @returns {boolean} whether restoring it is allowed.
 */
function restorable(top) {
  return top !== '.backup.json' && top !== '.DS_Store'
}

/**
 * Put one snapshot back as the live configuration, all or nothing.
 *
 * Every allow-listed entry the snapshot carries is copied over the current one,
 * which is first packed into a fresh safety snapshot (kind `pre-restore`) so the
 * restore itself can be undone. Entries missing from the snapshot are left
 * untouched: a snapshot may have been made before a directory existed.
 * @param {object} options - what to restore.
 * @param {string} options.root - backup directory holding the snapshot.
 * @param {string} options.home - configuration root to write into.
 * @param {string} options.id - snapshot id to restore.
 * @param {number} options.keepCount - retention used for the safety snapshot.
 * @returns {Promise<{id: string, safetyId: string, files: number, bytes: number, errors: number, foreign: string[]}>} the outcome.
 * @throws {Error} when the id is invalid, missing, or `home` and the snapshot are the same directory.
 */
export async function restoreSnapshot(options) {
  const root = path.resolve(options.root)
  const home = path.resolve(options.home)
  const id = options.id
  if (!SNAPSHOT_NAME.test(id)) throw new Error(`not a backup id: ${JSON.stringify(id)}`)
  const dir = path.join(root, id)
  const exists = await fs.stat(dir).then(info => info.isDirectory()).catch(() => false)
  if (!exists) throw new Error(`no backup named ${JSON.stringify(id)}`)
  // The backup directory usually lives inside the configuration root; only the
  // snapshot itself must not contain (or be contained by) the root.
  if (home === dir || home.startsWith(`${dir}${path.sep}`)) {
    throw new Error('the snapshot and the configuration root overlap')
  }
  const safety = await runBackup({
    home,
    targetDir: root,
    keepCount: Number(options.keepCount),
    include: [],
    exclude: [],
    kind: 'pre-restore',
  })
  const stats = { files: 0, bytes: 0, errors: 0 }
  const foreign = []
  for (const entry of await fs.readdir(dir)) {
    if (!restorable(entry)) continue
    if (!CONFIG_FILES.includes(entry) && !CONFIG_DIRS.includes(entry)) {
      foreign.push(entry)
      continue
    }
    await restoreEntry(path.join(dir, entry), path.join(home, entry), stats)
  }
  for (const name of CONFIG_FILES) {
    const present = await fs.stat(path.join(dir, name)).then(info => info.isFile()).catch(() => false)
    if (present && (await fs.stat(path.join(home, name)).catch(() => undefined)) === undefined) {
      stats.errors += 1
    }
  }
  return { id, safetyId: safety.entry.id, files: stats.files, bytes: stats.bytes, errors: stats.errors, foreign }
}
