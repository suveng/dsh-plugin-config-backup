/**
 * Host entry of the configuration-backup plugin: it resolves the settings,
 * mounts the {@link BackupService} as the `backups` Cordis Service, starts the
 * schedule, and exposes the same action to the agent as a tool.
 * @module dsh-plugin-config-backup
 */

import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { BackupService } from './service.js'
import { formatBytes } from './engine.js'

/** Cordis plugin name. */
export const name = 'config-backup'

/** Services the plugin reads: the tool registry and the agent-facing settings. */
export const inject = ['tools']

/** Plugin settings, editable on the Web plugin page. */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('已开启：按周期自动备份。一次都没有备份过时，Host 启动后 1 分钟会先备份一次。'),
  intervalHours: Schema.number()
    .default(6)
    .description('自动备份周期（小时），最小 0.1。'),
  keepCount: Schema.number()
    .default(14)
    .description('最多保留多少份备份，0 表示不清理。'),
  targetDir: Schema.string()
    .default('')
    .description('备份目录，留空则使用 $DSH_HOME/backups。'),
  notifyDesktop: Schema.boolean()
    .default(true)
    .description('备份完成后弹 macOS/linux 桌面通知。'),
  include: Schema.array(Schema.string())
    .default([])
    .description('除默认清单外还要备份的路径（相对 $DSH_HOME 或绝对路径）。'),
  exclude: Schema.array(Schema.string())
    .default([])
    .description('要跳过的路径（相对 $DSH_HOME 或绝对路径）。'),
})

/**
 * Mount the backup Service, its schedule, and its agent tool.
 * @param ctx - Host plugin Context.
 * @param config - resolved settings.
 * @returns {void} nothing: everything is registered as Context effects.
 */
export function apply(ctx, config) {
  const live = { ...config }
  const settings = () => normalize(live)
  const home = harnessHome()
  // The Service registers itself under `backups` from its constructor; calling
  // `ctx.set` here would be rejected because the name is already provided.
  const service = new BackupService(ctx, settings, home)
  // Cordis re-runs the callback body on every settings change, so editing the
  // plugin page rescopes the schedule instead of needing a Host restart.
  ctx.effect(() => {
    Object.assign(live, config)
    service.reschedule()
    return () => service.stop()
  }, 'config-backup: schedule')
  scheduleFirstRun(service, settings())

  ctx.inject(['tools'], toolCtx => {
    toolCtx.tools.register({
      name: 'config_backup_run',
      description: '立即备份 DeepSeek Harness 配置（$DSH_HOME 的配置文件、skills、storages 等）到备份目录，并按保留数量清理旧备份。用户要求“备份配置/立刻备份一下”时调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: ['manual', 'agent'],
            description: '备份原因标签，默认 agent。',
          },
        },
      },
      ...toolOutput('config_backup_run'),
      async execute(args) {
        const run = await service.runNow(args?.kind === 'manual' ? 'manual' : 'agent')
        if (!run.ok) throw new Error(`备份失败：${run.message ?? '未知错误'}`)
        return {
          id: run.id,
          files: run.files,
          bytes: run.bytes,
          bytesText: formatBytes(run.bytes),
          skipped: run.errors,
          removed: run.removed,
          targetDir: service.targetDir,
        }
      },
    })

    toolCtx.tools.register({
      name: 'config_backup_list',
      description: '列出已有的 DeepSeek Harness 配置备份：每份的时间、大小、路径，以及下次自动备份时间。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      ...toolOutput('config_backup_list'),
      async execute() {
        const snapshot = await service.status()
        return {
          targetDir: snapshot.targetDir,
          enabled: snapshot.enabled,
          intervalHours: snapshot.intervalHours,
          nextRunAt: snapshot.nextRunAt,
          keepCount: snapshot.keepCount,
          backups: snapshot.entries.map(entry => ({
            id: entry.id,
            at: new Date(entry.at).toISOString(),
            bytes: entry.bytes,
            bytesText: formatBytes(entry.bytes),
          })),
        }
      },
    })
  })
}

/**
 * Normalise raw settings so the Service never sees undefined or out-of-range values.
 * @param {Record<string, unknown>} config - resolved plugin configuration.
 * @returns {object} settings with every field present and clamped.
 */
function normalize(config) {
  const hours = Number(config?.intervalHours ?? 6)
  const keep = Number(config?.keepCount ?? 14)
  return {
    enabled: config?.enabled !== false,
    intervalHours: Number.isFinite(hours) ? Math.max(0.1, hours) : 6,
    keepCount: Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 14,
    targetDir: typeof config?.targetDir === 'string' ? config.targetDir : '',
    notifyDesktop: config?.notifyDesktop !== false,
    include: Array.isArray(config?.include) ? config.include.filter(item => typeof item === 'string') : [],
    exclude: Array.isArray(config?.exclude) ? config.exclude.filter(item => typeof item === 'string') : [],
  }
}

/**
 * Copy the first snapshot shortly after start when the schedule is on and no
 * snapshot exists yet, so a fresh install sees one without waiting a full period.
 * @param {BackupService} service - the mounted Service.
 * @param {object} settings - normalised settings.
 * @returns {void}
 */
function scheduleFirstRun(service, settings) {
  if (!settings.enabled) return
  const timer = setTimeout(() => {
    void (async () => {
      const snapshot = await service.status().catch(() => undefined)
      if (snapshot === undefined || snapshot.running) return
      if (snapshot.entries.length > 0) return
      await service.runNow('auto')
    })().catch(() => {})
  }, 60_000)
  timer.unref?.()
}

/**
 * The configuration root this Host serves: `$DSH_HOME`, else `~/.dsh`.
 * @returns {string} absolute path.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return join(home, '.dsh')
}

/**
 * Tool output shapes: a JSON schema and a renderer that keeps the agent reply short.
 * @param {'run' | 'list'} kind - which tool.
 * @returns {{output: object}} the `output` field of a tool definition.
 */
function toolOutput(kind) {
  if (kind === 'list') {
    return {
      output: {
        schema: {
          type: 'object',
          properties: {
            targetDir: { type: 'string' },
            enabled: { type: 'boolean' },
            intervalHours: { type: 'number' },
            nextRunAt: { type: 'number' },
            keepCount: { type: 'number' },
            backups: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  at: { type: 'string' },
                  bytes: { type: 'number' },
                  bytesText: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          const lines = value.backups.length === 0
            ? ['还没有备份。']
            : value.backups.map(entry => `- ${entry.id}（${entry.bytesText}）`)
          lines.push(`备份目录：${value.targetDir}`)
          lines.push(value.enabled ? `下次自动备份：${value.nextRunAt > 0 ? new Date(value.nextRunAt).toLocaleString() : '待定'}` : '自动备份未开启')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
    }
  }
  return {
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          files: { type: 'number' },
          bytes: { type: 'number' },
          bytesText: { type: 'string' },
          skipped: { type: 'number' },
          removed: { type: 'array', items: { type: 'string' } },
          targetDir: { type: 'string' },
        },
      },
      render(_args, value) {
        const removed = value.removed.length > 0 ? `，清理了 ${value.removed.length} 份旧备份` : ''
        return [{
          type: 'text',
          text: `已备份 ${value.files} 个文件（${value.bytesText}）到 ${value.targetDir}/${value.id}${removed}。`,
        }]
      },
    },
  }
}
