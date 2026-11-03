/**
 * Host entry of the configuration-backup plugin: it resolves the settings,
 * mounts the {@link BackupService} as the `backups` Cordis Service, starts the
 * schedule, and exposes the same action to the agent as a tool.
 * @module dsh-plugin-config-backup
 */

import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { BackupService } from './service.js'
import { exportSnapshot, formatBytes, importSnapshot, restoreSnapshot } from './engine.js'

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
  exportDir: Schema.string()
    .default('')
    .description('导出/导入备份包（.tar.gz）的默认目录，留空则使用系统临时目录。'),
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

    toolCtx.tools.register({
      name: 'config_backup_export',
      description: '把某份配置备份打包成 .tar.gz（默认在临时目录），供拷到另一台机器；用户说“导出备份/带到另一台机器/迁移配置”时调用。不带 id 时导出最新一份。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要导出的备份 id（YYYYMMDD-HHmmss）；省略则导出最新一份。' },
          outDir: { type: 'string', description: '输出目录；省略则用设置里的 exportDir，再不行用系统临时目录。' },
        },
      },
      ...toolOutput('export'),
      async execute(args) {
        const snapshot = await service.status()
        const id = args?.id || snapshot.entries[0]?.id
        if (!id) throw new Error('还没有任何备份，先运行 config_backup_run')
        const settings = service.settings()
        const outDir = typeof args?.outDir === 'string' && args.outDir.length > 0
          ? args.outDir
          : (settings.exportDir.length > 0 ? settings.exportDir : undefined)
        let archive
        try {
          archive = await exportSnapshot(service.targetDir, id, outDir)
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error))
        }
        return { ...archive, bytesText: formatBytes(archive.bytes) }
      },
    })

    toolCtx.tools.register({
      name: 'config_backup_import',
      description: '把别处（另一台机器）导出的 .tar.gz 备份包导入到本机备份列表；导入后可用 config_backup_restore 还原。用户说“导入备份/恢复另一台机器的配置/复用那台机器的配置”时调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          archive: { type: 'string', description: '备份包路径（.tar.gz）。' },
        },
        required: ['archive'],
      },
      ...toolOutput('import'),
      async execute(args) {
        const archive = typeof args?.archive === 'string' ? args.archive.trim() : ''
        if (archive.length === 0) throw new Error('需要提供备份包路径')
        let result
        try {
          result = await service.import(archive)
        } catch (error) {
          throw new Error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return {
          id: result.entry.id,
          files: result.entry.files,
          bytesText: formatBytes(result.entry.bytes),
          sourceHost: result.sourceHost,
          sourceAt: result.sourceAt,
          targetDir: service.targetDir,
        }
      },
    })

    toolCtx.tools.register({
      name: 'config_backup_restore',
      description: '把某份备份还原成本机当前的 dsh 配置（覆盖 AGENTS.md、skills、storages 等）。还原前会自动先备份当前配置，可再还原回去。会覆盖文件，调用前必须向用户确认要还原哪一份。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要还原的备份 id（YYYYMMDD-HHmmss）。' },
          confirm: { type: 'boolean', description: '用户已确认覆盖当前配置时传 true。' },
        },
        required: ['id'],
      },
      ...toolOutput('restore'),
      async execute(args) {
        if (args?.confirm !== true) {
          throw new Error('还原会覆盖当前配置，需要用户确认后带 confirm: true 重试')
        }
        const outcome = await service.restore(args.id)
        return {
          id: outcome.restore.id,
          safetyId: outcome.restore.safetyId,
          files: outcome.restore.files,
          bytes: outcome.restore.bytes,
          bytesText: formatBytes(outcome.restore.bytes),
          errors: outcome.restore.errors,
          foreign: outcome.restore.foreign,
          home: outcome.snapshot.home,
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
    exportDir: typeof config?.exportDir === 'string' ? config.exportDir : '',
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
 * @param {'run' | 'list' | 'export' | 'import' | 'restore'} kind - which tool.
 * @returns {{output: object}} the `output` field of a tool definition.
 */
function toolOutput(kind) {
  if (kind === 'export') {
    return {
      output: {
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            name: { type: 'string' },
            id: { type: 'string' },
            bytes: { type: 'number' },
            bytesText: { type: 'string' },
            sha256: { type: 'string' },
          },
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: `已导出 ${value.id} → ${value.file}（${value.bytesText}）。拿到另一台机器后：dsh-plugin-config-backup 面板 → 导入，或运行 config_backup_import。`,
          }]
        },
      },
    }
  }
  if (kind === 'import') {
    return {
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            files: { type: 'number' },
            bytesText: { type: 'string' },
            sourceHost: { type: 'string' },
            sourceAt: { type: 'string' },
            targetDir: { type: 'string' },
          },
        },
        render(_args, value) {
          const from = value.sourceHost.length > 0 ? `，来自 ${value.sourceHost}` : ''
          return [{
            type: 'text',
            text: `已导入备份 ${value.id}（${value.files} 个文件 ${value.bytesText}${from}）到 ${value.targetDir}。要让它生效，再执行 config_backup_restore（id=${value.id}）。`,
          }]
        },
      },
    }
  }
  if (kind === 'restore') {
    return {
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            safetyId: { type: 'string' },
            files: { type: 'number' },
            bytes: { type: 'number' },
            bytesText: { type: 'string' },
            errors: { type: 'number' },
            foreign: { type: 'array', items: { type: 'string' } },
            home: { type: 'string' },
          },
        },
        render(_args, value) {
          const lines = [
            `已用 ${value.id} 还原 ${value.files} 个文件（${value.bytesText}）到 ${value.home}。`,
            `还原前的配置另存为 ${value.safetyId}，需要时再还原它即可撤销。`,
            '重启 dsh 后新配置完全生效。',
          ]
          if (value.errors > 0) lines.push(`${value.errors} 项写入失败，请检查权限。`)
          if (value.foreign.length > 0) lines.push(`快照里这些顶层项不是已知配置目录，已跳过：${value.foreign.join('、')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
    }
  }
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
