# dsh-plugin-config-backup

**DeepSeek Harness（DSH）的配置定时备份插件** —— 侧边栏一个「备份」入口，按周期把 `~/.dsh` 里的配置复制成快照，备份完成后弹系统通知 + 页面提示。

- 这是 **DSH 插件**（cordis 插件包），装进 profile 后由 DSH 进程自己加载，不需要另起进程、不需要 cron。
- 备份是**纯文件复制**，不打包、不压缩：每份快照就是一个普通目录，需要恢复时直接拿里面的文件盖回去。

## 能力

| 能力 | 说明 |
| --- | --- |
| 侧边栏面板 | 左侧栏图标「备份」，点开是一页：状态卡片（是否定时、下次备份、上次备份、备份目录）+ 备份记录列表 |
| 立即备份 | 面板右上角「立即备份」，按钮切换成「正在备份…」直到完成 |
| 定时备份 | 默认每 6 小时一份；在设置页改周期后无需重启，定时器自动重排 |
| 首启备份 | 开启定时但一份备份都没有时，Host 启动 1 分钟后先补一份，不用等满一个周期 |
| 保留策略 | 默认保留最近 14 份，超出自动删最旧的；可以在设置页改，0 表示不清理 |
| 完成通知 | macOS 用 `osascript` 弹系统通知、Linux 用 `notify-send`；页面开着时右上角还有一条 toast |
| Agent 工具 | `config_backup_run`（立刻备份）/ `config_backup_list`（列出备份 + 下次时间），直接在对话里让模型调用 |
| 排除大目录 | `node_modules`、`.git`、`.cache`、`.pnpm-store` 永不复制；备份目录自己也不会被备份进去 |

## 备份什么

配置根是 `$DSH_HOME`，未设置时为 `~/.dsh`。默认清单：

- **按文件**：`AGENTS.md`、`settings.yaml`、`cordis.patch.yml`、`cordis.yml`、`.env`、`.credentials.yaml`、`.npmrc`、`README.md`、`USER.md`、`MEMORY.md`
- **按目录**：`skills`、`storages`、`presets`、`commands`、`agents`、`mcp`、`prompts`、`templates`

不包含：`profiles/`（`node_modules` 动辄上百 MB，重新安装比备份便宜）、`sessions/`、`attachments/`、`_backup/`。
要加别的路径，在设置页填 `include`；要排除某个文件，填 `exclude`（相对 `$DSH_HOME` 或绝对路径都可以）。

> `.env` 和 `.credentials.yaml` 含凭据。备份目录默认在 `~/.dsh/backups`，权限取决于你的 umask；如果要多机同步，请自己加密后再同步。

## 安装

1. 确认 DSH 已能启动 Web：`dsh web`，记下它打印的 `http://127.0.0.1:<port>`。
2. 把仓库装进 profile（路径换成你 clone 的位置）：

   ```bash
   dsh plugin --profile web add /Users/you/github/dsh-plugin-config-backup
   ```

   或在 Web 的插件页里「从本地目录安装」。
3. `dsh plugin add` 只装包、不改 profile 清单，还需要两步（都改 `~/.dsh/profiles/web/`）：

   - `package.json` 的 `dsh.profile.bundles` 里加一条 `"dsh-plugin-config-backup"`；
   - `cordis.patch.yml` 末尾追加：

     ```yaml
     - insert:
         - id: config-backup
           name: dsh-plugin-config-backup
           config:
             enabled: true
             intervalHours: 6
             keepCount: 14
             notifyDesktop: true
     ```

   （在 Web 插件页把该 bundle 打开，第一步会自动完成。）
4. 重启 `dsh web`（或 dsh 桌面端），左侧栏出现「备份」图标。
5. 点开面板，点「立即备份」验证一次；`~/.dsh/backups/<YYYYMMDD-HHmmss>/` 应出现，并收到桌面通知。

## 设置

设置页 → 插件 → 备份：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否开启定时备份 |
| `intervalHours` | `6` | 备份周期（小时），最小 0.1 |
| `keepCount` | `14` | 保留份数，`0` 表示不清理 |
| `targetDir` | 空 | 备份目录，空则用 `$DSH_HOME/backups` |
| `notifyDesktop` | `true` | 完成后是否弹桌面通知 |
| `include` | `[]` | 额外要备份的路径 |
| `exclude` | `[]` | 要跳过的路径 |

## 恢复一份备份

1. 关掉 DSH（`Ctrl+C` `dsh web`，或退出桌面端）。
2. 进备份目录，挑一份：`ls -lt ~/.dsh/backups | head`。
3. 先把当前配置挪走，再拷回：

   ```bash
   mv ~/.dsh ~/.dsh.broken
   mkdir -p ~/.dsh
   cp -R ~/.dsh.broken/../.dsh-backup/20261103-120000/. ~/.dsh/  # 换成实际快照
   ```

   （更稳的做法：把快照目录整个复制成 `~/.dsh`，再把 `profiles/` 从旧目录拷进去，省一次重装依赖。）
4. 重新 `dsh web`。

每份快照里有 `.backup.json`，记录时间、来源目录、文件数、字节数和是否有项被跳过。

## 全局技能

插件自带 `skills/dsh-config-backup/SKILL.md`，供 agent 判断"备份/恢复/改周期"这类请求该怎么做。装到全局技能目录：

```bash
mkdir -p ~/.dsh/skills/dsh-config-backup
cp ~/.dsh/profiles/web/node_modules/dsh-plugin-config-backup/skills/dsh-config-backup/SKILL.md ~/.dsh/skills/dsh-config-backup/
```

之后任何工作区的会话都能自动发现它（`~/.dsh/skills/` 是用户级技能根），也可以 `/dsh-config-backup` 手动调用。

## Agent 工具

对话里直接说「备份一下配置」即可，或显式调用：

- `config_backup_run`：立刻备份，返回快照 id、文件数、大小、清理掉的旧快照数。
- `config_backup_list`：列出所有备份（id、大小）、备份目录、下次自动备份时间。

## 实现要点

- Host 侧 `BackupService` 是 cordis Service（名字 `backups`），带 typert Remote 方法 `status` / `run` / `remove` / `prune`。没有生成 typert 产物，靠 Gateway 的源码回退（source-mode）暴露。
- 面板走共享的 `/api` RPC 通道：`POST /api/backups/status`，body 是 `{type:'client-request', rpcId, method:'backups/status', payload:{args:{}}}`。客户端没有该命名空间的 `ctx.remote` 绑定，所以用 `fetch`。
- 面板每 5 秒轮询一次 `status()`，用响应里的 `token` 判断状态是否变化；同一个页面还顺带轮询一次，用来在别人（定时/其它会话）触发备份时弹 toast。
- cordis 给调用方的是 Service 的派生副本，所以运行状态放在实例字段 `this.state` 上，不放模块级 WeakMap。

## 开发

```bash
npm test              # 引擎 + 清单一致性测试（无需依赖）
npm run test:service  # Service 测试，需要本机已安装 DSH
```

`test/loader.mjs` 把 `@deepseek-ai/*` 解析到本机 DSH 安装目录（默认全局安装路径，可用 `DSH_INSTALL` 覆盖），所以仓库里不需要 `node_modules`。

目录：

```text
lib/index.js    Host 入口：Config、Service 挂载、定时任务、Agent 工具
lib/service.js  backups Service：定时器、去重、状态、Remote 方法、桌面通知
lib/engine.js   备份引擎：复制、快照命名、保留策略、删除
lib/client.js   Web 面板：侧边栏入口、面板、toast、样式
locale/*.json   插件元信息（标题/描述）
test/           引擎、Service、清单一致性测试
```

## 限制

- 桌面通知：macOS 用 `osascript`（已实测），Linux 用 `notify-send`；Windows 不弹桌面通知（面板、toast 和工具照常工作）。
- 装完插件要手动塞进 `dsh.profile.bundles`，`dsh plugin add` 不会自动做这件事。
- 备份目录不能放在被备份的目录树里再被 include 进去（引擎会主动跳过自己）。
- 快照是完整副本，配置很大时（`skills`、`storages` 里塞了大文件）会占空间；用 `keepCount` 或 `exclude` 控制。

## License

MIT
