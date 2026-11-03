import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} file - path relative to the package root.
 * @returns {string} file contents.
 */
function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

/** @type {object} package manifest. */
const manifest = JSON.parse(read('package.json'))

test('the manifest points at files that exist', () => {
  for (const target of Object.values(manifest.exports)) {
    if (target.includes('*')) continue
    assert.equal(existsSync(join(root, target)), true, target)
  }
  assert.equal(existsSync(join(root, manifest.dsh.bundle.patch)), true)
  assert.equal(existsSync(join(root, 'lib', 'client.js')), true)
})

test('the bundle patch inserts the plugin under a stable id', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: config-backup/)
  assert.match(patch, new RegExp(`name: ${manifest.name}`))
})

test('both locales define the same keys, including the sidebar label', () => {
  const zh = JSON.parse(read('locale/zh.json'))
  const en = JSON.parse(read('locale/en.json'))
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of ['meta.title', 'meta.description', 'panel', 'title', 'backupNow']) {
    assert.equal(typeof zh[key], 'string', `zh ${key}`)
    assert.equal(typeof en[key], 'string', `en ${key}`)
  }
})

test('the client registers the sidebar entry, its panel, and a toast', () => {
  const client = read('lib/client.js')
  assert.match(client, /slots\.inject\('sidebar\.panellist'/)
  assert.match(client, /slots\.inject\('main'/)
  assert.match(client, /slots\.inject\('shell\.overlay'/)
  // The panel reaches the Host over the shared RPC channel, not a generated binding.
  assert.match(client, /api\/backups\/\$\{method\}/)
  assert.match(client, /type: 'client-request'/)
  assert.equal(/ctx\.remote\.[a-zA-Z]+\./.test(client), false)
})

test('the host entry mounts the service and its tools', () => {
  const entry = read('lib/index.js')
  assert.match(entry, /export function apply\(ctx, config\)/)
  assert.match(entry, /new BackupService\(ctx, settings, home\)/)
  // The Service provides itself; a second ctx.set would throw in Cordis.
  assert.doesNotMatch(entry, /ctx\.set\('backups'/)
  assert.match(entry, /config_backup_run/)
  assert.match(entry, /config_backup_list/)
  assert.match(entry, /config_backup_export/)
  assert.match(entry, /config_backup_import/)
  assert.match(entry, /config_backup_restore/)
})
