import assert from 'node:assert/strict'
import { mkdtemp, rm as remove, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { BackupService } from '../lib/service.js'

/** Schedule timers to stop once this file's tests finish. */
const cleanups = []

after(() => {
  for (const stop of cleanups.splice(0)) stop()
})

/**
 * Mounted service plus the fixture home it backs up.
 * @param {object} [settings] - plugin settings overrides.
 * @returns {Promise<{ctx: object, home: string, service: object, settings: object}>} the fixture.
 */
async function mount(settings = {}) {
  const home = await mkdtemp(join(tmpdir(), 'config-backup-svc-'))
  await writeFile(join(home, 'cordis.patch.yml'), '- []\n')
  const live = {
    enabled: true,
    intervalHours: 6,
    keepCount: 3,
    targetDir: '',
    notifyDesktop: false,
    include: [],
    exclude: [],
    ...settings,
  }
  const ctx = new Context()
  const service = new BackupService(ctx, () => live, home)
  // The plugin entry does this right after mounting; without it there is no timer.
  service.reschedule()
  cleanups.push(() => service.stop())
  return { ctx, home, settings: live, service: ctx.get('backups') }
}

test('the service exports exactly the Remote methods the panel calls', () => {
  // `remoteMethods` reads the prototype of a live instance, so probe an instance.
  const names = remoteMethods({ __proto__: BackupService.prototype }).map(marker => marker.method).sort()
  assert.deepEqual(names, ['prune', 'remove', 'run', 'status'])
})

test('status reports the schedule and an empty history', async t => {
  const { ctx, home, service } = await mount()
  t.after(() => remove(home, { recursive: true, force: true }))
  const status = await service.status()
  assert.equal(status.enabled, true)
  assert.equal(status.intervalHours, 6)
  assert.equal(status.keepCount, 3)
  assert.equal(status.targetDir, join(home, 'backups'))
  assert.equal(status.running, false)
  assert.equal(status.lastRun, null)
  assert.deepEqual(status.entries, [])
  assert.ok(status.nextRunAt > Date.now())
  assert.equal(typeof ctx.get('backups').status, 'function')
})

test('run writes a snapshot and records it as the last run', async t => {
  const { home, service } = await mount()
  t.after(() => remove(home, { recursive: true, force: true }))
  const { entry, snapshot } = await service.run()
  assert.equal(entry.ok, true)
  assert.equal(entry.kind, 'manual')
  assert.ok(entry.files >= 1)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].id, entry.id)
  assert.equal(snapshot.lastRun.id, entry.id)
})

test('concurrent run calls share one backup', async t => {
  const { home, service } = await mount()
  t.after(() => remove(home, { recursive: true, force: true }))
  const [first, second] = await Promise.all([service.run(), service.runNow('auto')])
  assert.equal(first.entry.id, second.id)
  assert.equal((await service.status()).entries.length, 1)
})

test('remove deletes one snapshot and rejects unknown or malformed ids', async t => {
  const { home, service } = await mount()
  t.after(() => remove(home, { recursive: true, force: true }))
  const { entry } = await service.run()
  const after = await service.remove(entry.id)
  assert.deepEqual(after.entries, [])
  await assert.rejects(() => service.remove(entry.id), { code: 'backup/not-found' })
  await assert.rejects(() => service.remove('..'), { code: 'backup/invalid-id' })
})

test('a disabled schedule stops the timer and drops nextRunAt', async t => {
  const { home, service, settings } = await mount()
  t.after(() => remove(home, { recursive: true, force: true }))
  assert.ok((await service.status()).nextRunAt > 0)
  settings.enabled = false
  service.reschedule()
  assert.equal((await service.status()).nextRunAt, 0)
  assert.equal((await service.status()).enabled, false)
  service.stop()
})

test('prune applies retention without creating a snapshot', async t => {
  const { home, service, settings } = await mount({ keepCount: 1 })
  t.after(() => remove(home, { recursive: true, force: true }))
  await service.run()
  await new Promise(resolve => setTimeout(resolve, 1_050))
  await service.run()
  assert.equal((await service.status()).entries.length, 1)
  settings.keepCount = 0
  const result = await service.prune()
  assert.deepEqual(result.removed, [])
  assert.equal(result.snapshot.entries.length, 1)
})
