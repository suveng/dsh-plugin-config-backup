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
| 导出备份包 | 记录列表每行「导出」→ 打成 `dsh-backup-<id>.tar.gz`（默认写系统临时目录，可用 `exportDir` 改） |
| 导入备份包 | 右上角「选择文件」选另一台机器导出的 `.tar.gz`，导入成一条新记录；同一包不会重复导入 |
| 还原 | 记录列表每行「恢复」，确认后用该备份覆盖当前配置；覆盖前自动先存一份 `pre-restore` 保护备份 |
| Agent 工具 | `config_backup_run` / `config_backup_list` / `config_backup_export` / `config_backup_import` / `config_backup_restore`，直接在对话里让模型调用 |
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
| `exportDir` | 空 | 导出备份包的默认目录，空则用系统临时目录 |

## 还原一份备份

面板：备份记录里点某份的「恢复」→ 确认框 → 完成。当前配置会先自动备份成一份 `pre-restore`，所以还原本身也能撤回。

对话：让模型调 `config_backup_restore`（需要 `id`，会要求先确认）。

手动（没有面板时）：

```bash
ls -lt ~/.dsh/backups | head                 # 挑一份
mv ~/.dsh ~/.dsh.broken                      # 旧配置挪走
cp -R ~/.dsh.broken/backups/<id> ~/.dsh      # 快照拷回
cp -R ~/.dsh.broken/profiles ~/.dsh/profiles # 依赖目录不用重装
```

还原后重启 dsh。每份快照里有 `.backup.json`，记录时间、来源主机、文件数、字节数、是否有项被跳过；导入来的快照还带 `importedFrom` 与 `source`（源包 SHA-256，用于去重）。

## 换一台机器

1. 旧机器：面板点某份备份的「导出」，得到 `/tmp/dsh-backup-<id>.tar.gz`（或用 `config_backup_export` 指定 `outDir`）。
2. 拷到新机器（AirDrop、`scp`、U 盘都行）。
3. 新机器装好 dsh 与本插件，面板右上角「选择文件」选中那个 `.tar.gz` → 记录里多出一条（标记「导入」）。
4. 点该条「恢复」→ 重启 dsh。

注意事项：

- 包里有 `.env`、`.credentials.yaml`，别传到公开仓库或网盘共享链接。
- `profiles/` 不进包（体积大且含各平台二进制依赖），新机器靠自己的 `dsh plugin add` 装依赖；模型/插件等配置在 `storages/` 与 `cordis.patch.yml` 里，会跟着过来。
- 同名快照不会覆盖，导入时自动加 `-1`、`-2` 后缀。
- 导入只往记录里加一条，不会自动覆盖；要生效必须再点「恢复」。

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
- `config_backup_export`：导出某份（默认最新一份）为 `.tar.gz`，返回文件路径与 SHA-256。
- `config_backup_import`：导入指定的 `.tar.gz`。
- `config_backup_restore`：还原某份备份，必须带 `confirm: true`。

## 实现要点

- Host 侧 `BackupService` 是 cordis Service（名字 `backups`），带 typert Remote 方法 `status` / `run` / `remove` / `prune` / `origin` / `restore`。没有生成 typert 产物，靠 Gateway 的源码回退（source-mode）暴露。
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
lib/engine.js   备份引擎：复制、快照命名、保留策略、删除、导出/导入 tar.gz、还原
lib/client.js   Web 面板：侧边栏入口、面板、toast、样式
locale/*.json   插件元信息（标题/描述）
test/           引擎、Service、清单一致性测试
```

## 限制

- 桌面通知：macOS 用 `osascript`（已实测），Linux 用 `notify-send`；Windows 不弹桌面通知（面板、toast 和工具照常工作）。
- 装完插件要手动塞进 `dsh.profile.bundles`，`dsh plugin add` 不会自动做这件事。
- 备份目录不能放在被备份的目录树里再被 include 进去（引擎会主动跳过自己）。
- 浏览器出于安全不暴露所选文件的绝对路径（Electron 25+ 去掉了 `File.path`）。「选择文件」用 Chromium/Electron 的 `file.path` 直接读；在普通浏览器里会提示改用 `config_backup_import` 传路径。
- 导出包自己也是手写的 ustar+gzip（不引入 tar 依赖），只打包常规文件、目录和符号链接：没有属主信息、超过 100 字节的路径会被跳过。
- 快照是完整副本，配置很大时（`skills`、`storages` 里塞了大文件）会占空间；用 `keepCount` 或 `exclude` 控制。

## License

MIT
