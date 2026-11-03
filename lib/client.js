/**
 * Web client of the configuration-backup plugin: a sidebar entry, the backup
 * panel it opens, and a toast that reports a finished backup while the page is
 * open.
 *
 * The panel reaches the Host over the shared `/api` RPC channel with plain
 * `fetch` (`POST /api/backups/<method>`): a plugin without a generated Typert
 * artifact has no `ctx.remote.<namespace>` binding on the Client, but the
 * Gateway still dispatches source-mode Remote methods on that channel. The
 * panel polls `status()`, whose token only changes on a transition.
 * @module dsh-plugin-config-backup/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-config-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Sidebar entry id; the same string is the main-panel key it opens. */
    const PANEL_ID = 'config-backup'
    /** Locale namespace. */
    const NS = 'config-backup'
    /** Poll period of the panel and the toast watcher. */
    const POLL_MS = 5_000

    const zh = {
      'meta.title': '备份',
      'meta.description': '定时备份 DeepSeek Harness 配置并保留最近若干份，侧边栏查看备份历史。',
      panel: '备份',
      title: '配置备份',
      subtitle: '定时把 dsh 配置（配置、skills、存储等）复制到备份目录，完成后用系统通知和页面提示告诉你。',
      'schedule.on': '定时备份已开启',
      'schedule.off': '定时备份已关闭',
      'next.run': '下次备份',
      'next.off': '未开启',
      'last.run': '上次备份',
      'last.never': '还没有备份记录',
      backupNow: '立即备份',
      backingUp: '正在备份…',
      refresh: '刷新',
      loading: '正在读取备份状态…',
      'error.title': '备份面板读不到数据',
      retry: '重试',
      history: '备份记录',
      'history.empty': '还没有备份。点「立即备份」生成第一份，之后按周期自动备份。',
      'history.count': '共 {total} 份',
      location: '备份目录',
      schedule: '自动备份',
      'toast.done.auto': '定时备份完成：{files} 个文件（{size}）',
      'toast.done.manual': '手动备份完成：{files} 个文件（{size}）',
      'toast.done.agent': '会话触发备份完成：{files} 个文件（{size}）',
      'toast.failed': '备份失败：{message}',
      'kind.auto': '定时',
      'kind.manual': '手动',
      'kind.agent': '会话',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.in': '{n} 小时后',
      'time.inMinutes': '{n} 分钟后',
      denied: '当前页面不是本机所有者会话，无法读取备份状态。',
      'denied.detail': '{message}',
      export: '导出',
      exporting: '正在导出…',
      'export.hint': '把某份备份打包成 .tar.gz，拷到另一台机器后用「导入」还原配置。',
      'export.dirNote': '导出包默认写到系统临时目录，可在插件设置里改 exportDir。',
      'import.title': '导入备份包',
      'import.pick': '选择文件',
      'import.hint': '选择另一台机器导出的 dsh-backup-*.tar.gz，导入后出现在记录里，再点「恢复」应用。',
      'import.done': '已导入备份 {id}（来自 {host}，{size}）。点「恢复」应用到本机。',
      'import.failed': '导入失败：{message}',
      restore: '恢复',
      restoring: '正在恢复…',
      'restore.confirm': '用 {id} 覆盖当前配置？\n\n会覆盖 AGENTS.md、settings.yaml、cordis.patch.yml、.env、.credentials.yaml、skills、storages 等。当前配置会先自动备份一份，可随时再还原回去。',
      'restore.done': '已用 {id} 还原 {files} 个文件；还原前的配置存为 {safety}。重启 dsh 后完全生效。',
      'restore.failed': '恢复失败：{message}',
      'restore.blocked': '有 {n} 个文件没能覆盖（例如 {files}）：它们不属于配置清单，dsh 为避免删除或覆盖你的其他文件而跳过了。',
      'export.done': '已导出到 {file}（{size}）',
      'export.failed': '导出失败：{message}',
      'kind.pre-restore': '还原前',
      'kind.import': '导入',
      'last.note': '上次备份是还原前的保护备份',
      hint: '点某份备份的「导出」打包成 .tar.gz，带到另一台机器后点「选择文件」导入，再点「恢复」应用。',
      'import.pathOnly': '浏览器拿不到这个文件的完整路径：请在「备份」面板里点「选择文件」，或改用 config_backup_import 指定路径。',
    }

    const en = {
      'meta.title': 'Backups',
      'meta.description': 'Scheduled backups of the DeepSeek Harness configuration, with a sidebar history.',
      panel: 'Backups',
      title: 'Config backups',
      subtitle: 'Periodically copies the dsh configuration (settings, skills, stores) into a backup folder and tells you with a system notification and a page toast.',
      'schedule.on': 'Scheduled backups are on',
      'schedule.off': 'Scheduled backups are off',
      'next.run': 'Next backup',
      'next.off': 'Off',
      'last.run': 'Last backup',
      'last.never': 'No backups yet',
      backupNow: 'Back up now',
      backingUp: 'Backing up…',
      refresh: 'Refresh',
      loading: 'Reading backup status…',
      'error.title': 'The backup panel cannot read its data',
      retry: 'Retry',
      history: 'Backups',
      'history.empty': 'No backups yet. Use "Back up now" for the first one; later ones run on the schedule.',
      'history.count': '{total} total',
      location: 'Backup folder',
      schedule: 'Schedule',
      'toast.done.auto': 'Scheduled backup complete: {files} files ({size})',
      'toast.done.manual': 'Manual backup complete: {files} files ({size})',
      'toast.done.agent': 'Session backup complete: {files} files ({size})',
      'toast.failed': 'Backup failed: {message}',
      'kind.auto': 'scheduled',
      'kind.manual': 'manual',
      'kind.agent': 'session',
      'time.justNow': 'just now',
      'time.minutes': '{n} minutes ago',
      'time.hours': '{n} hours ago',
      'time.days': '{n} days ago',
      'time.in': 'in {n} hours',
      'time.inMinutes': 'in {n} minutes',
      denied: 'This page is not the owner session, so it cannot read backups.',
      'denied.detail': '{message}',
      export: 'Export',
      exporting: 'Exporting…',
      'export.hint': 'Packs a backup into a .tar.gz you can carry to another machine and import there.',
      'export.dirNote': 'Archives are written to the system temp directory; change exportDir in the plugin settings.',
      'import.title': 'Import a backup archive',
      'import.pick': 'Choose file',
      'import.hint': 'Pick a dsh-backup-*.tar.gz exported elsewhere; it lands in the list, then press Restore.',
      'import.done': 'Imported {id} from {host} ({size}). Press Restore to apply it.',
      'import.failed': 'Import failed: {message}',
      restore: 'Restore',
      restoring: 'Restoring…',
      'restore.confirm': 'Overwrite the current configuration with {id}?\n\nThis rewrites AGENTS.md, settings.yaml, cordis.patch.yml, .env, .credentials.yaml, skills, storages and so on. The current configuration is backed up first, so it can be restored again.',
      'restore.done': 'Restored {files} files from {id}; the previous configuration is saved as {safety}. Restart dsh for everything to take effect.',
      'restore.failed': 'Restore failed: {message}',
      'restore.blocked': '{n} files were left alone (for example {files}): they are not configuration files, so dsh skipped them rather than overwrite or delete them.',
      'export.done': 'Exported to {file} ({size})',
      'export.failed': 'Export failed: {message}',
      'kind.pre-restore': 'pre-restore',
      'kind.import': 'imported',
      'last.note': 'the last backup is the safety copy taken before a restore',
      hint: 'Export a backup into a .tar.gz, import it on another machine with Choose file, then press Restore to apply it.',
      'import.pathOnly': 'The browser does not expose the full path of the chosen file: use "Choose file" in this panel, or call config_backup_import with a path.',
    }

    const CSS = [
      '.dsh-cb-page{width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dsh-cb-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}',
      '.dsh-cb-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}',
      '.dsh-cb-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:24px}[data-platform=darwin] .dsh-cb-heading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}',
      '.dsh-cb-heading h1{margin:0;font-size:20px;font-weight:500;line-height:28px}',
      '.dsh-cb-heading p{margin:4px 0 0;max-width:640px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-actions{display:flex;align-items:center;gap:8px;flex:none;white-space:nowrap}',
      '.dsh-cb-button{height:32px;padding:0 12px;border-radius:16px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))}',
      '.dsh-cb-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}',
      '.dsh-cb-button:disabled{opacity:.5;cursor:default}',
      '.dsh-cb-primary{background:var(--dsw-alias-brand-primary, #4d6bfe);border-color:transparent;color:#fff}',
      '.dsh-cb-primary:hover:not(:disabled){filter:brightness(1.05)}',
      '.dsh-cb-card{border-radius:12px;background:var(--dsw-specific-sidebar-fill, rgba(0,0,0,.03));padding:4px 14px;margin-bottom:24px}',
      '.dsh-cb-row{display:flex;align-items:baseline;gap:12px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))}.dsh-cb-row:last-child{border-bottom:none}',
      '.dsh-cb-label{flex:none;width:88px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-value{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.dsh-cb-mono{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px}',
      '.dsh-cb-historyHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 10px}',
      '.dsh-cb-historyHead h2{margin:0;font-size:14px;font-weight:500}',
      '.dsh-cb-historyHead span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-entry{display:flex;align-items:center;gap:12px;padding:8px;border-radius:12px}',
      '.dsh-cb-entry:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}',
      '.dsh-cb-index{flex:none;width:16px;height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
      '.dsh-cb-entryBody{flex:1;min-width:0}',
      '.dsh-cb-entryTitle{font-weight:500;line-height:23px}',
      '.dsh-cb-entryMeta{margin-top:2px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-entryId{flex:none;font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-note{margin:0 0 16px;padding:12px 14px;border-radius:10px;background:var(--dsw-specific-sidebar-fill, rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}',
      '.dsh-cb-noteError{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary, #c4564a)}',
      '.dsh-cb-link{background:none;border:none;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}',
      '.dsh-cb-toast{position:absolute;right:20px;top:calc(var(--dsh-frame-overlay-top, 20px) + 4px);display:flex;align-items:center;gap:8px;max-width:420px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-overlay, #fff);border:.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));box-shadow:0 6px 24px rgba(0,0,0,.12);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;animation:dsh-cb-toast-in .16s ease-out}',
      '@keyframes dsh-cb-toast-in{from{opacity:0;transform:translateY(-4px)}}',
      '.dsh-cb-dot{flex:none;width:8px;height:8px;border-radius:50%}',
      '.dsh-cb-toastText{flex:1;min-width:0}',
      '.dsh-cb-toastClose{flex:none;background:none;border:none;padding:0 2px;font-size:16px;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-cb-entryActions{flex:none;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .12s}',
      '.dsh-cb-entry:hover .dsh-cb-entryActions,.dsh-cb-entry:focus-within .dsh-cb-entryActions{opacity:1}',
      '@media (hover:none){.dsh-cb-entryActions{opacity:1}}',
      '.dsh-cb-small{height:26px;padding:0 10px;border-radius:13px;font-size:12px}',
      '.dsh-cb-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary, #c4564a);border-color:currentColor}',
      '.dsh-cb-section{margin:0 0 24px}',
      '.dsh-cb-sectionTitle{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cb-ok{color:var(--dsw-alias-state-success-primary, #3f8f5c)}',
      '@media (prefers-reduced-motion:reduce){.dsh-cb-toast{animation:none}}',
    ].join('\n')

    if (typeof document !== 'undefined') {
      const tagId = 'dsh-plugin-config-backup/panel.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-config-backup'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template - template text.
     * @param {Record<string, unknown>} [values] - replacements.
     * @returns {string} formatted text.
     */
    function format(template, values) {
      const bag = values || {}
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(bag, key) ? String(bag[key]) : match))
    }

    /**
     * @param {number} bytes - byte count.
     * @returns {string} short human size.
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
      return `${rounded} ${units[unit]}`
    }

    /**
     * @param {number} at - epoch milliseconds.
     * @returns {string} absolute local time.
     */
    function formatTime(at) {
      if (!Number.isFinite(at) || at <= 0) return ''
      try {
        return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      } catch {
        return new Date(at).toString()
      }
    }

    /**
     * @param {number} at - epoch milliseconds.
     * @param {(key: string) => string} t - translator.
     * @returns {string} relative time, past or future.
     */
    function formatRelative(at, t) {
      if (!Number.isFinite(at) || at <= 0) return ''
      const minutes = Math.round((at - Date.now()) / 60_000)
      const future = minutes > 0
      const abs = Math.abs(minutes)
      if (abs < 1) return t('time.justNow')
      if (future) {
        return abs < 60 ? format(t('time.inMinutes'), { n: abs }) : format(t('time.in'), { n: Math.round(abs / 60) })
      }
      if (abs < 60) return format(t('time.minutes'), { n: abs })
      const hours = Math.round(abs / 60)
      return hours < 24 ? format(t('time.hours'), { n: hours }) : format(t('time.days'), { n: Math.round(hours / 24) })
    }

    /**
     * The sidebar glyph: an archive box. Sized by the sidebar row.
     * @param {{size?: number}} props - requested edge length.
     * @returns {object} an inline SVG element.
     */
    function BackupIcon(props) {
      const size = props && props.size ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 3 }),
      h('path', { d: 'M3.5 12.2h4.1l1.5 2.6h5.8l1.5-2.6h4.1' }),
      h('path', { d: 'M12 6.6v3.2' }))
    }

    /**
     * POST one Remote method on the shared `/api` channel.
     * @param {'status' | 'run' | 'prune'} method - endpoint under `/api/backups/`.
     * @param {Record<string, unknown>} [args] - named arguments.
     * @returns {Promise<unknown>} the business value.
     * @throws {Error} carrying `code` when the RPC result is a failure.
     */
    async function call(method, args) {
      const rpcId = `config-backup-${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const response = await fetch(`api/backups/${method}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `backups/${method}`,
          payload: { args: args || {} },
        }),
      })
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`HTTP ${response.status}`)
        error.code = 'remote-access/denied'
        throw error
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const envelope = await response.json()
      if (envelope === null || envelope.type !== 'server-response') throw new Error('unexpected response envelope')
      if (envelope.result && envelope.result.ok === true) return envelope.result.value
      const failure = (envelope.result && envelope.result.error) || {}
      const error = new Error(failure.message || 'Remote call failed')
      error.code = failure.code || 'gateway/internal'
      throw error
    }

    /**
     * @param {unknown} error - thrown value.
     * @returns {string} text for the panel.
     */
    function errorText(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /**
     * Poll the Host status and publish it to subscribers.
     * @returns {{ useSnapshot: () => object | null, refresh: () => Promise<unknown>, start: () => void }} the source.
     */
    function createSource() {
      const listeners = new Set()
      let snapshot = null
      let inFlight = null
      const publish = next => {
        snapshot = next
        for (const listener of listeners) listener()
      }
      const subscribe = listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const read = () => {
        if (inFlight !== null) return inFlight
        inFlight = call('status')
          .then(value => {
            publish({ state: 'ready', value })
            return value
          })
          .catch(error => {
            const denied = Boolean(error) && error.code === 'remote-access/denied'
            publish({ state: denied ? 'denied' : 'error', error })
            return null
          })
          .then(result => {
            inFlight = null
            return result
          })
        return inFlight
      }
      const readSnapshot = () => snapshot
      return {
        useSnapshot() {
          // Third argument keeps server-side rendering and hydration legal; the
          // panel only ever paints in the Host's browser renderer.
          return React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
        },
        refresh: read,
        start() {
          void read()
        },
      }
    }

    /**
     * One newest toast message.
     * @returns {{ useToast: () => object | null, push: (toast: object) => void, dismiss: () => void, clear: () => void }} the store.
     */
    function createToastStore() {
      const listeners = new Set()
      let current = null
      let seq = 0
      let timer = null
      const publish = () => {
        for (const listener of listeners) listener()
      }
      const dismiss = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        current = null
        publish()
      }
      return {
        useToast() {
          const readCurrent = () => current
          return React.useSyncExternalStore(listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          }, readCurrent, readCurrent)
        },
        push(toast) {
          seq += 1
          current = { ...toast, seq }
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(dismiss, toast.tone === 'error' ? 9_000 : 5_000)
          publish()
        },
        dismiss,
        clear: dismiss,
      }
    }

    /** The floating toast rendered into `shell.overlay`. */
    function BackupToast(props) {
      const t = props.t
      const toast = props.store.useToast()
      if (toast === null) return null
      return h('div', {
        className: 'dsh-cb-toast',
        role: 'status',
        key: toast.seq,
        onClick: props.store.dismiss,
      },
      h('span', { className: 'dsh-cb-dot', style: { background: toast.tone === 'error' ? 'var(--dsw-alias-state-error-primary, #c4564a)' : 'var(--dsw-alias-state-success-primary, #3f8f5c)' } }),
      h('span', { className: 'dsh-cb-toastText' }, toast.text),
      h('button', {
        type: 'button',
        className: 'dsh-cb-toastClose',
        'aria-label': t('panel'),
        onClick: event => {
          event.stopPropagation()
          props.store.dismiss()
        },
      }, '×'))
    }

    /** One row of the backup history, with its export and restore actions. */
    function BackupEntry(props) {
      const entry = props.entry
      const t = props.t
      const busy = props.busy
      return h('div', { className: 'dsh-cb-entry' },
        h('span', { className: 'dsh-cb-index' }, String(props.index + 1)),
        h('div', { className: 'dsh-cb-entryBody' },
          h('div', { className: 'dsh-cb-entryTitle' }, formatTime(entry.at)),
          h('div', { className: 'dsh-cb-entryMeta' }, `${formatRelative(entry.at, t)} · ${formatBytes(entry.bytes)}`)),
        h('span', { className: 'dsh-cb-entryId' }, entry.id),
        h('div', { className: 'dsh-cb-entryActions' },
          h('button', {
            type: 'button',
            className: 'dsh-cb-button dsh-cb-small',
            disabled: busy,
            onClick: () => props.onExport(entry),
          }, t('export')),
          h('button', {
            type: 'button',
            className: 'dsh-cb-button dsh-cb-small dsh-cb-danger',
            disabled: busy,
            onClick: () => props.onRestore(entry),
          }, t('restore'))))
    }

    /** One label/value line of the summary card. */
    function CardRow(props) {
      return h('div', { className: 'dsh-cb-row' },
        h('span', { className: 'dsh-cb-label' }, props.label),
        h('span', { className: props.mono ? 'dsh-cb-value dsh-cb-mono' : 'dsh-cb-value' }, props.value))
    }

    /**
     * The main panel the sidebar entry opens.
     * @param {{ t: (key: string) => string }} props - slot props with the bound translator.
     * @returns {object} the panel element.
     */
    function BackupPanel(props) {
      // The slot hands the panel a bound translator; keep a fallback so an
      // unexpected slot shape degrades to raw keys instead of crashing.
      const t = typeof props.t === 'function' ? props.t : props.t?.t ?? (key => key)
      const sourceRef = React.useRef(null)
      if (sourceRef.current === null) sourceRef.current = createSource()
      const source = sourceRef.current
      const snapshot = source.useSnapshot()
      const busyState = React.useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const errorState = React.useState(null)
      const actionError = errorState[0]
      const setActionError = errorState[1]

      React.useEffect(() => {
        source.start()
        const timer = setInterval(() => void source.refresh(), POLL_MS)
        return () => clearInterval(timer)
      }, [source])

      const state = snapshot === null ? 'loading' : snapshot.state
      const value = snapshot !== null && snapshot.state === 'ready' ? snapshot.value : null
      const running = busy || (value !== null && value.running === true)

      const create = () => {
        if (running) return
        setBusy(true)
        setActionError(null)
        call('run')
          .catch(error => setActionError(errorText(error)))
          .then(() => {
            setBusy(false)
            void source.refresh()
          })
      }
      const refresh = () => {
        void source.refresh()
      }
      const fileRef = React.useRef(null)
      const noteState = React.useState(null)
      const note = noteState[0]
      const setNote = noteState[1]

      const withBusy = (task) => {
        if (running) return
        setBusy(true)
        setActionError(null)
        setNote(null)
        Promise.resolve()
          .then(task)
          .catch(error => setActionError(errorText(error)))
          .then(() => {
            setBusy(false)
            void source.refresh()
          })
      }
      const exporting = entry => withBusy(async () => {
        const archive = await call('origin', { id: entry.id })
        setNote({ tone: 'success', text: format(t('export.done'), { file: archive.file, size: archive.bytesText || formatBytes(archive.bytes) }) })
      })
      const restoring = entry => {
        if (running) return
        const question = format(t('restore.confirm'), { id: entry.id })
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return
        withBusy(async () => {
          const result = await call('restore', { id: entry.id })
          // The Host refuses to overwrite files a restore does not own; report it
          // instead of claiming success.
          const blocked = Array.isArray(result.restore.blocked) ? result.restore.blocked : []
          if (blocked.length > 0) {
            throw new Error(format(t('restore.blocked'), { n: blocked.length, files: blocked.slice(0, 3).join(', ') }))
          }
          setNote({
            tone: result.restore.errors > 0 ? 'error' : 'success',
            text: format(t('restore.done'), {
              id: result.restore.id,
              files: result.restore.files,
              safety: result.restore.safetyId,
            }),
          })
        })
      }
      const importing = () => {
        const input = fileRef.current
        if (input === null || input === undefined) return
        input.value = ''
        input.click()
      }
      const importFile = async file => {
        if (!file) return
        const archive = file.path
        withBusy(async () => {
          if (typeof archive !== 'string' || archive.length === 0) throw new Error(t('import.pathOnly'))
          const result = await call('import', { archive })
          setNote({
            tone: 'success',
            text: format(t('import.done'), {
              id: result.entry.id,
              host: result.sourceHost || '—',
              size: formatBytes(result.entry.bytes),
            }),
          })
        })
      }

      const children = []
      children.push(h('header', { className: 'dsh-cb-heading', key: 'heading' },
        h('div', null,
          h('h1', null, t('title')),
          h('p', null, t('subtitle'))),
        h('div', { className: 'dsh-cb-actions' },
          h('button', { type: 'button', className: 'dsh-cb-button', onClick: importing, disabled: running }, t('import.pick')),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: '.tar.gz,application/gzip,application/x-gzip',
            style: { display: 'none' },
            onChange: event => void importFile(event.target.files && event.target.files[0]),
          }),
          h('button', { type: 'button', className: 'dsh-cb-button', onClick: refresh, disabled: running }, t('refresh')),
          h('button', { type: 'button', className: 'dsh-cb-button dsh-cb-primary', onClick: create, disabled: running }, running ? t('backingUp') : t('backupNow')))))

      if (value === null && state === 'loading') children.push(h('p', { className: 'dsh-cb-note', key: 'loading' }, t('loading')))
      if (state === 'denied' || state === 'error') {
        children.push(h('div', { className: 'dsh-cb-note dsh-cb-noteError', key: 'error' },
          h('strong', null, state === 'denied' ? t('denied') : t('error.title')),
          h('span', null, errorText(snapshot ? snapshot.error : '')),
          h('button', { type: 'button', className: 'dsh-cb-link', onClick: refresh }, t('retry'))))
      }
      if (actionError !== null) children.push(h('p', { className: 'dsh-cb-note dsh-cb-noteError', key: 'actionError' }, actionError))
      if (note !== null) {
        children.push(h('p', {
          className: note.tone === 'error' ? 'dsh-cb-note dsh-cb-noteError' : 'dsh-cb-note dsh-cb-ok',
          key: 'note',
        }, note.text))
      }

      if (value !== null) {
        // The newest snapshot is the last backup even before this Host process
        // has run one, so the row never reads "no backups yet" above a list.
        const newest = value.entries[0]
        const last = value.lastRun ?? (newest === undefined ? null : { id: newest.id, at: newest.at, kind: newest.kind || 'auto', bytes: newest.bytes, ok: true })
        children.push(h('div', { className: 'dsh-cb-card', key: 'card' },
          h(CardRow, { label: t('schedule'), value: value.enabled ? t('schedule.on') : t('schedule.off') }),
          h(CardRow, {
            label: t('next.run'),
            value: value.enabled && value.nextRunAt > 0
              ? `${formatTime(value.nextRunAt)} · ${formatRelative(value.nextRunAt, t)}`
              : t('next.off'),
          }),
          h(CardRow, {
            label: t('last.run'),
            value: last === null
              ? t('last.never')
              : `${formatTime(last.at)} · ${t(`kind.${last.kind}`)} · ${formatBytes(last.bytes)}`,
          }),
          h(CardRow, { label: t('location'), value: value.targetDir, mono: true })))

        children.push(h('p', { className: 'dsh-cb-note', key: 'hint' }, t('hint')))
        const entries = value.entries.map((entry, index) => h(BackupEntry, {
          entry,
          index,
          t,
          key: entry.id,
          busy: running,
          onExport: exporting,
          onRestore: restoring,
        }))
        children.push(h('div', { className: 'dsh-cb-history', key: 'history' },
          h('div', { className: 'dsh-cb-historyHead' },
            h('h2', null, t('history')),
            h('span', null, format(t('history.count'), { total: value.entries.length }))),
          entries.length === 0 ? h('p', { className: 'dsh-cb-note' }, t('history.empty')) : entries))
      }

      return h('section', { className: 'dsh-cb-page', 'aria-label': t('title'), 'data-testid': 'config-backup-page' },
        h('div', { className: 'dsh-cb-scroll' },
          h('div', { className: 'dsh-cb-content' }, children)))
    }

    /**
     * Report finished runs as toasts while the page is open, whoever started them.
     * @param {(key: string) => string} t - translator.
     * @param {{ push: (toast: object) => void }} store - toast store.
     * @returns {() => void} stop function.
     */
    function watchRuns(t, store) {
      let lastToken = null
      let lastRunAt = null
      let stopped = false
      const tick = async () => {
        if (stopped) return
        try {
          const status = await call('status')
          if (stopped) return
          const changed = lastToken !== status.token
          lastToken = status.token
          const run = status.lastRun
          if (!changed || run === null || run.at === lastRunAt) return
          lastRunAt = run.at
          if (run.ok) {
            store.push({ tone: 'success', text: format(t(`toast.done.${run.kind}`), { files: run.files, size: formatBytes(run.bytes) }) })
          }
          else store.push({ tone: 'error', text: format(t('toast.failed'), { message: run.message || '' }) })
        } catch {
          // Host restarting or channel lost: the next tick retries.
        }
      }
      const timer = setInterval(() => void tick(), POLL_MS)
      void tick()
      return () => {
        stopped = true
        clearInterval(timer)
        store.clear()
      }
    }

    /**
     * Mount the sidebar entry, the panel, and the toast.
     * @param {object} ctx - Client root Context.
     * @returns {void} nothing.
     */
    function apply(ctx) {
      ctx.locale.register(NS, { zh, en })
      const t = ctx.locale.bind(NS)
      const store = createToastStore()

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel'),
      }, BackupIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, BackupPanel))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'config-backup-toast',
        locale: NS,
        inject: () => ({ store }),
      }, BackupToast))

      ctx.effect(() => watchRuns(t, store), 'config-backup: run toasts')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
