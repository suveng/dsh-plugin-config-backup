import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm as remove } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CONFIG_DIRS,
  CONFIG_FILES,
  exportSnapshot,
  importSnapshot,
  listSnapshots,
  pruneSnapshots,
  readLatestMeta,
  removeSnapshot,
  restoreSnapshot,
  runBackup,
  snapshotName,
  snapshotTime,
} from '../lib/engine.js'

/**
 * Build a throwaway configuration root.
 * @returns {Promise<string>} absolute path of the fixture home.
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'config-backup-'))
  for (const file of CONFIG_FILES) await writeFile(join(home, file), `# ${file}\n`)
  const skills = join(home, 'skills', 'demo')
  await mkdir(skills, { recursive: true })
  await writeFile(join(skills, 'SKILL.md'), '# skill\n')
  // A dependency tree must never be copied wholesale.
  await mkdir(join(home, 'skills', 'demo', 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(home, 'skills', 'demo', 'node_modules', 'dep', 'index.js'), 'export {}\n')
  return home
}

/**
 * @param {string} home - fixture home.
 * @param {object} [overrides] - extra options.
 * @returns {Promise<{entry: object, retention: object}>} one finished backup.
 */
function backup(home, overrides = {}) {
  return runBackup({ home, targetDir: join(home, 'backups'), keepCount: 5, include: [], exclude: [], kind: 'manual', ...overrides })
}

test('snapshot names round-trip through local time', () => {
  const at = new Date(2026, 10, 3, 9, 5, 7)
  assert.equal(snapshotName(at), '20261103-090507')
  assert.equal(snapshotTime('20261103-090507'), at.getTime())
  assert.equal(snapshotTime('not-a-snapshot'), undefined)
  assert.equal(snapshotTime('20261103-0905'), undefined)
})

test('a backup copies the allow-listed configuration and skips node_modules', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const { entry } = await backup(home)
  assert.equal(entry.kind, 'manual')
  assert.equal(entry.errors, 0)
  assert.ok(entry.files > 0)
  assert.ok(entry.bytes > 0)
  assert.equal(await readFile(join(entry.path, 'AGENTS.md'), 'utf8'), '# AGENTS.md\n')
  assert.equal(await readFile(join(entry.path, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# skill\n')
  assert.equal(snapshotTime(entry.id) !== undefined, true)
  const manifest = JSON.parse(await readFile(join(entry.path, '.backup.json'), 'utf8'))
  assert.equal(manifest.id, entry.id)
  assert.equal(manifest.home, home)
})

test('a backup never copies its own target directory', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const target = join(home, 'snapshots')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'stale.txt'), 'old')
  const { entry } = await runBackup({ home, targetDir: target, keepCount: 5, include: [], exclude: [], kind: 'auto' })
  const inside = await listSnapshots(entry.path).catch(() => [])
  assert.deepEqual(inside, [])
  assert.equal(entry.path.startsWith(target), true)
})

test('exclude and include adjust the copied set', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  await writeFile(join(home, 'extra.txt'), 'extra')
  const { entry } = await backup(home, { exclude: ['.env'], include: ['extra.txt'] })
  const names = JSON.parse(await readFile(join(entry.path, '.backup.json'), 'utf8'))
  assert.equal(names.errors, 0)
  const listing = await readFile(join(entry.path, 'extra.txt'), 'utf8').catch(() => undefined)
  assert.equal(listing, 'extra')
  const excluded = await readFile(join(entry.path, '.env'), 'utf8').catch(() => undefined)
  assert.equal(excluded, undefined)
})

test('retention keeps the newest snapshots', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const target = join(home, 'backups')
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    // Distinct names: sleep past the one-second resolution.
    await new Promise(resolve => setTimeout(resolve, 1_050))
    const { entry } = await runBackup({ home, targetDir: target, keepCount: 2, include: [], exclude: [], kind: 'auto' })
    ids.push(entry.id)
  }
  const left = (await listSnapshots(target)).map(row => row.id)
  assert.deepEqual(left, [ids[2], ids[1]])
})

test('pruneSnapshots with keepCount 0 is a no-op', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const { entry } = await backup(home)
  const result = await pruneSnapshots(join(home, 'backups'), 0)
  assert.deepEqual(result.removed, [])
  assert.equal(snapshotTime(entry.id) !== undefined, true)
  assert.equal((await listSnapshots(join(home, 'backups'))).length, 1)
})

test('removeSnapshot rejects ids that are not snapshot names', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  await backup(home)
  await assert.rejects(() => removeSnapshot(join(home, 'backups'), '../etc'), /not a backup id/)
  await assert.rejects(() => removeSnapshot(join(home, 'backups'), 'nope'), /not a backup id/)
  assert.equal(await removeSnapshot(join(home, 'backups'), '20000101-000000'), false)
})

test('the newest manifest is readable from the target directory', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const { entry } = await backup(home)
  const meta = await readLatestMeta(join(home, 'backups'))
  assert.equal(meta.id, entry.id)
  assert.ok(CONFIG_DIRS.includes('skills'))
})

test('collision-suffixed snapshot names are still readable and removable', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  const root = join(home, 'backups')
  const first = await backup(home)
  const second = await backup(home)
  assert.notEqual(second.entry.id, first.entry.id)
  assert.ok(second.entry.id.endsWith('-1'))
  const ids = (await listSnapshots(root)).map(row => row.id).sort()
  assert.deepEqual(ids, [first.entry.id, second.entry.id].sort())
  assert.equal(await removeSnapshot(root, second.entry.id), true)
})

test('export, import, and restore move a configuration between machines', async t => {
  const source = await fixture()
  const target = await fixture()
  t.after(() => remove(source, { recursive: true, force: true }))
  t.after(() => remove(target, { recursive: true, force: true }))
  const sourceRoot = join(source, 'backups')
  const { entry } = await backup(source)
  const archive = await exportSnapshot(sourceRoot, entry.id, join(source, 'out'))
  t.after(() => remove(archive.file, { force: true }))
  assert.ok(archive.bytes > 0)
  assert.match(archive.sha256, /^[0-9a-f]{64}$/)

  const targetRoot = join(target, 'backups')
  const imported = await importSnapshot(targetRoot, archive.file)
  assert.equal(imported.entry.id, entry.id)
  assert.equal(imported.manifest.host.length > 0, true)
  assert.equal(await readFile(join(imported.entry.path, 'AGENTS.md'), 'utf8'), '# AGENTS.md\n')

  await assert.rejects(importSnapshot(targetRoot, archive.file), /already imported/)

  await writeFile(join(target, 'AGENTS.md'), 'changed here\n')
  const outcome = await restoreSnapshot({ root: targetRoot, home: target, id: imported.entry.id, keepCount: 5 })
  assert.equal(outcome.errors, 0)
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), '# AGENTS.md\n')
  assert.equal(await readFile(join(target, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# skill\n')
  // The configuration overwritten by the restore survives as kind `pre-restore`.
  const rows = await listSnapshots(targetRoot)
  const safety = rows.find(row => row.id === outcome.safetyId)
  assert.equal(safety.kind, 'pre-restore')
  assert.equal(await readFile(join(safety.path, 'AGENTS.md'), 'utf8'), 'changed here\n')
})

test('restore refuses a snapshot id that does not exist', async t => {
  const home = await fixture()
  t.after(() => remove(home, { recursive: true, force: true }))
  await backup(home)
  await assert.rejects(
    restoreSnapshot({ root: join(home, 'backups'), home, id: '20200101-000000', keepCount: 5 }),
    /no backup named/,
  )
})
