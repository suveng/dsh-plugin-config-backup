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

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/** A snapshot directory name: `YYYYMMDD-HHmmss`. */
const SNAPSHOT_NAME = /^\d{8}-\d{6}$/

/**
 * @typedef {'auto' | 'manual' | 'agent'} BackupKind
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
 * @returns {Promise<Array<{id: string, path: string, createdAt: number, bytes: number}>>} snapshots.
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
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, '.backup.json'), 'utf8'))
      if (typeof meta?.bytes === 'number') bytes = meta.bytes
    } catch {
      bytes = await directorySize(dir)
    }
    rows.push({ id: entry.name, path: dir, createdAt, bytes })
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
