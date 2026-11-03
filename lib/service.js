/**
 * The `backups` Service: it owns the schedule, runs at most one backup at a
 * time, remembers the latest outcome, and lets the Web panel poll for changes.
 *
 * Wire surface (source-mode Remote, no generated artifact, reached through the
 * shared `/api` RPC channel):
 *   POST /api/backups/status  args {}      → BackupSnapshot
 *   POST /api/backups/run     args {}      → { entry, snapshot }
 *   POST /api/backups/remove  args { id }  → BackupSnapshot
 *   POST /api/backups/prune   args {}      → { removed, snapshot }
 *
 * @module dsh-plugin-config-backup/service
 */

import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { formatBytes, listSnapshots, pruneSnapshots, removeSnapshot, runBackup } from './engine.js'

const exec = promisify(execFile)

/** Symbol under which Cordis records the object a Service proxy stands for. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Symbol under which Cordis marks an object that it already wraps. */
const CORDIS_SHADOW = Symbol.for('cordis.shadow')

/** Prototype slot the Typert protocol keeps Remote markers in. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * @typedef {object} BackupSettings
 * @property {boolean} enabled Whether the schedule runs.
 * @property {number} intervalHours Hours between two automatic backups.
 * @property {number} keepCount Snapshots to keep in the target directory.
 * @property {string} targetDir Directory that holds every snapshot, or '' for the default.
 * @property {boolean} notifyDesktop Post a desktop notification once a backup finishes.
 * @property {string[]} include Extra paths to copy beside the allow-listed configuration.
 * @property {string[]} exclude Paths to skip, relative to the configuration root or absolute.
 * @typedef {'auto' | 'manual' | 'agent'} BackupKind
 * @typedef {object} BackupRun
 * @property {string} id Snapshot id.
 * @property {number} at Epoch milliseconds the run finished.
 * @property {string} kind Who asked for the backup.
 * @property {boolean} ok Whether the snapshot was written.
 * @property {number} files Files copied.
 * @property {number} bytes Bytes copied.
 * @property {number} errors Entries skipped.
 * @property {string[]} removed Snapshots deleted by retention during this run.
 * @property {string} [message] Failure message when `ok` is false.
 * @typedef {object} BackupState
 * @typedef {object} BackupSnapshot
 * @property {string} token Changes on every state transition: poll `status()` and compare.
 * @property {boolean} running A backup is in progress.
 * @property {boolean} enabled The schedule is on.
 * @property {number} intervalHours Configured cadence, 0 when the schedule is off.
 * @property {number} keepCount Configured retention.
 * @property {string} targetDir Absolute backup directory.
 * @property {string} home Configuration root being backed up.
 * @property {number} nextRunAt Epoch milliseconds of the next scheduled run, 0 when off.
 * @property {BackupRun | null} lastRun The most recent finished run.
 * @property {Array<{id: string, at: number, bytes: number}>} entries Snapshots, newest first.
 */

/**
 * Mutable run state of one Service. It hangs off the instance as `state` rather
 * than living in a module table: Cordis serves callers a shallow copy of the
 * instance, so an own field is shared by every caller while a lookup keyed by
 * `this` is not.
 * @typedef {object} BackupState
 * @property {number} token Changes on every transition.
 * @property {number} changedAt Epoch milliseconds of the last transition.
 * @property {number} [timer] Schedule timer, absent when the schedule is off.
 * @property {string} targetDir Absolute directory holding snapshots.
 * @property {string} home Configuration root being copied.
 * @property {BackupSettings} [settings] Live settings, imported once by the plugin.
 * @property {Promise<BackupRun> | undefined} running The run in flight, shared by concurrent callers.
 * @property {BackupRun | null} lastRun The most recent finished run.
 */

/**
 * @param {object} service - a {@link BackupService}.
 * @returns {BackupState} its mutable run state.
 */
function stateOf(service) {
  return service.state
}

/**
 * @param {object} service - a {@link BackupService}.
 * @returns {BackupSettings} the live configuration.
 */
function settingsOf(service) {
  const state = stateOf(service)
  if (state.settings === undefined) throw new Error('config-backup: the backup Service has no settings yet')
  return state.settings
}

/**
 * @param {object} service - a {@link BackupService}.
 * @returns {string} the absolute backup directory for the current settings.
 */
function targetDirOf(service) {
  const configured = settingsOf(service).targetDir
  return configured !== undefined && configured.trim().length > 0
    ? resolve(configured.trim())
    : join(stateOf(service).home, 'backups')
}

/**
 * @param {object} service - a {@link BackupService}.
 * @returns {number | undefined} the schedule period in milliseconds, or undefined when the schedule is off.
 */
function intervalMs(service) {
  const settings = settingsOf(service)
  const hours = Number(settings.intervalHours)
  if (!settings.enabled || !Number.isFinite(hours) || hours <= 0) return undefined
  return Math.max(60_000, hours * 3_600_000)
}

/**
 * Mark one state transition visible to pollers.
 * @param {object} service - a {@link BackupService}.
 * @returns {void}
 */
function touch(service) {
  const state = stateOf(service)
  state.token += 1
  state.changedAt = Date.now()
}

/**
 * Clear the schedule timer, if any.
 * @param {object} service - a {@link BackupService}.
 * @returns {void}
 */
function stopTimer(service) {
  const state = stateOf(service)
  if (state.timer !== undefined) {
    clearInterval(state.timer)
    state.timer = undefined
  }
}

/**
 * Run one backup, sharing an in-flight copy with any concurrent caller, then
 * post the desktop notification.
 * @param {object} service - a {@link BackupService}.
 * @param {BackupKind} kind - who asked for the backup.
 * @returns {Promise<BackupRun>} the finished run, successful or not.
 */
async function runOnce(service, kind) {
  const state = stateOf(service)
  if (state.running !== undefined) return await state.running
  const settings = settingsOf(service)
  const targetDir = state.targetDir
  const task = (async () => {
    touch(service)
    /** @type {BackupRun} */
    let run
    try {
      const { entry, retention } = await runBackup({
        home: state.home,
        targetDir,
        keepCount: Number(settings.keepCount),
        include: settings.include ?? [],
        exclude: settings.exclude ?? [],
        kind,
      })
      run = {
        id: entry.id,
        at: Date.now(),
        kind,
        ok: true,
        files: entry.files,
        bytes: entry.bytes,
        errors: entry.errors,
        removed: retention.removed,
      }
    } catch (error) {
      run = {
        id: '',
        at: Date.now(),
        kind,
        ok: false,
        files: 0,
        bytes: 0,
        errors: 0,
        removed: [],
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      state.running = undefined
      touch(service)
    }
    state.lastRun = run
    if (settings.notifyDesktop) await notifyDesktop(run)
    touch(service)
    return run
  })()
  state.running = task
  return await task
}

/**
 * Post a desktop notification. A notification never fails the backup it reports.
 * @param {BackupRun} run - the finished run.
 * @returns {Promise<void>} settles when the notifier returns.
 */
async function notifyDesktop(run) {
  const title = run.ok ? 'dsh 配置备份完成' : 'dsh 配置备份失败'
  const body = run.ok
    ? `${new Date(run.at).toLocaleString()} · ${run.files} 个文件 · ${formatBytes(run.bytes)}${run.errors > 0 ? ` · ${run.errors} 项跳过` : ''}`
    : (run.message ?? '未知错误')
  try {
    if (process.platform === 'darwin') {
      await exec('osascript', ['-e', `display notification ${appleScript(body)} with title ${appleScript(title)}`])
    } else if (process.platform === 'linux') {
      await exec('notify-send', ['--app-name=dsh', title, body])
    }
  } catch {
    // No desktop session or notifier installed: the panel still shows the run.
  }
}

/**
 * Quote one string as an AppleScript literal.
 * @param {string} value - text to embed.
 * @returns {string} a double-quoted literal with backslashes and quotes escaped.
 */
function appleScript(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Mark one public method as a Remote export of the `backups` namespace.
 *
 * The TypeScript compiler emits this through `@Remote(name)`; this plugin is
 * plain JavaScript, so the class body stays decorator-free (existing tools in
 * this checkout parse plugin sources without decorators) and the marker is
 * installed around the class definition instead.
 * @param {Function} target - the class whose prototype receives the marker.
 * @param {string} method - public instance method name.
 * @returns {void}
 */
function declareRemote(target, method) {
  const prototype = target.prototype
  /** Stand-in for the decorated function's class instance: callbacks see it as `this`. */
  const holder = Object.create(prototype)
  const receiver = {
    addInitializer(callback) {
      callback.call(holder)
    },
  }
  Remote(method)(prototype[method], {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer: receiver.addInitializer,
  })
  if (methodOf(prototype).includes(method) === false) {
    throw new Error(`typert-protocol: Remote marker for "${method}" was not installed`)
  }
}

/**
 * The Remote-visible backup controller.
 */
export class BackupService extends TypertRemoteService {
  /**
   * @param ctx - owning Context.
   * @param {() => BackupSettings} readSettings - reads the live plugin configuration.
   * @param {string} home - the configuration root to copy.
   */
  constructor(ctx, readSettings, home) {
    super(ctx, 'backups', { namespace: 'backups' })
    /** Absolute directory holding every snapshot; refreshed on each reschedule. */
    /** @type {BackupState} */
    this.state = {
      token: 0,
      changedAt: Date.now(),
      targetDir: '',
      home,
      settings: readSettings(),
      running: undefined,
      lastRun: null,
    }
    this.state.targetDir = targetDirOf(this)
  }

  /**
   * @returns {string} the absolute backup directory.
   */
  get targetDir() {
    return stateOf(this).targetDir
  }

  /**
   * @returns {number} epoch milliseconds of the next scheduled run, 0 when off.
   */
  get nextRunAt() {
    const state = stateOf(this)
    if (state.timer === undefined) return 0
    const interval = intervalMs(this)
    return interval === undefined ? 0 : state.changedAt + interval
  }

  /**
   * Re-read the configuration: pick up a new target directory and restart the
   * schedule. The plugin calls this on start and on every settings change.
   * @returns {void}
   */
  reschedule() {
    const state = stateOf(this)
    stopTimer(this)
    state.targetDir = targetDirOf(this)
    const interval = intervalMs(this)
    state.changedAt = Date.now()
    if (interval !== undefined) {
      state.timer = setInterval(() => {
        void this.runNow('auto')
      }, interval)
      // A backup schedule must not keep the Host process alive.
      state.timer.unref?.()
    }
    state.token += 1
  }

  /**
   * Stop the schedule; the plugin calls this on dispose.
   * @returns {void}
   */
  stop() {
    stopTimer(this)
  }

  /**
   * Mark one state transition visible to pollers: the token changes, so every
   * open panel refreshes on its next tick.
   * @returns {void}
   */
  touch() {
    touch(this)
  }

  /**
   * Read the whole panel state.
   * @returns {Promise<BackupSnapshot>} current schedule, latest run, and snapshots.
   */
  async status() {
    const state = stateOf(this)
    const settings = settingsOf(this)
    const rows = await listSnapshots(state.targetDir)
    const intervalHours = Number(settings.intervalHours)
    return {
      token: String(state.token),
      running: state.running !== undefined,
      enabled: Boolean(settings.enabled),
      intervalHours: Number.isFinite(intervalHours) ? intervalHours : 0,
      keepCount: Number(settings.keepCount),
      targetDir: state.targetDir,
      home: state.home,
      nextRunAt: this.nextRunAt,
      lastRun: state.lastRun,
      entries: rows.map(row => ({ id: row.id, at: row.createdAt, bytes: row.bytes })),
    }
  }

  /**
   * Create one backup now.
   * @returns {Promise<{entry: BackupRun, snapshot: BackupSnapshot}>} the finished run and the refreshed state.
   * @throws {RemoteError} `backup/failed` when the copy failed.
   */
  async run() {
    const entry = await this.runNow('manual')
    if (!entry.ok) throw new RemoteError('backup/failed', entry.message ?? 'backup failed', { id: entry.id })
    stateOf(this).lastRun = entry
    return { entry, snapshot: await this.status() }
  }

  /**
   * Delete one snapshot.
   * @param {string} id - snapshot directory name, `YYYYMMDD-HHmmss`.
   * @returns {Promise<BackupSnapshot>} the refreshed state.
   * @throws {RemoteError} `backup/not-found` or `backup/invalid-id`.
   */
  async remove(id) {
    let existed
    try {
      existed = await removeSnapshot(stateOf(this).targetDir, id)
    } catch (error) {
      throw new RemoteError('backup/invalid-id', error instanceof Error ? error.message : String(error), { id })
    }
    if (!existed) throw new RemoteError('backup/not-found', `no backup named ${JSON.stringify(id)}`, { id })
    touch(this)
    return await this.status()
  }

  /**
   * Apply retention without creating a snapshot.
   * @returns {Promise<{removed: string[], snapshot: BackupSnapshot}>} removed ids and the refreshed state.
   */
  async prune() {
    const retention = await pruneSnapshots(stateOf(this).targetDir, Number(settingsOf(this).keepCount))
    touch(this)
    return { removed: retention.removed, snapshot: await this.status() }
  }

  /**
   * Run one backup on behalf of the schedule, a panel click, or an agent tool.
   * @param {BackupKind} kind - who asked for the backup.
   * @returns {Promise<BackupRun>} the finished run, successful or not.
   */
  runNow(kind) {
    return runOnce(this, kind)
  }
}

/**
 * @param {object} prototype - a class prototype.
 * @returns {string[]} names of the methods already marked Remote there.
 */
function methodOf(prototype) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  return descriptor === undefined ? [] : descriptor.value.methods.map(marker => marker.method)
}

declareRemote(BackupService, 'status')
declareRemote(BackupService, 'run')
declareRemote(BackupService, 'remove')
declareRemote(BackupService, 'prune')
