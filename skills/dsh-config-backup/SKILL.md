---
name: dsh-config-backup
description: 用户要"备份一下 dsh 配置""看看都有哪些备份""把配置搬到另一台机器""导入/导出备份包""还原某份备份""怎么改备份周期/保留份数/备份了哪些文件""备份失败/没有备份记录/通知没弹"时使用。办法是调用 dsh-plugin-config-backup 提供的 config_backup_run / config_backup_list / config_backup_export / config_backup_import / config_backup_restore 工具，或走侧边栏「备份」面板；信息不够时读 ~/.dsh/backups/.backup.json 与 profile 补丁层里 config-backup 条目的 config。
whenToUse: 与 dsh 配置备份相关的任何请求——立即备份、列备份、导出备份包迁移机器、导入备份包、还原、改周期、改保留数、改备份目录或 include/exclude、排查备份没跑/没通知/目录不存在/快照被清理。
---

# dsh 配置备份（dsh-config-backup）

插件：[dsh-plugin-config-backup](https://github.com/suveng/dsh-plugin-config-backup)（Cordis 插件，Host 服务名 `backups`，Remote 命名空间 `backups`）。
入口三处：侧边栏「备份」面板、对话工具 `config_backup_run` / `config_backup_list` / `config_backup_export` / `config_backup_import` / `config_backup_restore`、设置页 → 插件 → 备份。

## 定数的东西（不要现算或猜）

- 配置根：`$DSH_HOME`，未设置时为 `~/.dsh`。
- 备份目录：配置 `targetDir`，空则 `$DSH_HOME/backups`；快照名 `YYYYMMDD-HHmmss`（本地时间，已存在时追加 `-N`）。
- 每份快照内有 `.backup.json`：`{id,home,kind,files,bytes,errors,createdAt,startedAt}`；`kind` 取 `auto` / `manual` / `agent` / `pre-restore`（还原前自动存的保护快照）/ `import`；导入的快照另有 `importedFrom` 与 `source`（源包 SHA-256，导入时据此去重）。
- 导出包：`dsh-backup-<id>.tar.gz`，默认写到系统临时目录（`/tmp`），设置项 `exportDir` 可改；包内只有一个 `<id>/` 目录。
- 默认周期 6 小时，默认保留 14 份，`keepCount: 0` = 不清理。
- 永不复制：`profiles/`、`node_modules`、`.git`、`.cache`、`.pnpm-store`、`.DS_Store`、备份目录自身。
- 生效的配置不在插件自己的文件里，而在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `- id: config-backup` 那段 `config:`。

## Steps

1. **先看有没有工具**：`config_backup_list` 能列就说明插件装着且 Host 已加载；报"未知工具"就跳到第 4 步排查。
2. **要立刻备份** → 调 `config_backup_run`（`kind: "manual"`）。返回 `{id, files, bytesText, skipped, removed, targetDir}`；`skipped > 0` 时把原始错误告诉用户（大多是权限或文件被占用）。
3. **要列备份 / 说下次什么时候备份** → 调 `config_backup_list`。只有 `backups: []` 时才说"还没有备份"，不要说"备份失败"。
4. **工具不存在**：按顺序查三处再动手——
   - `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 有没有 `dsh-plugin-config-backup`；
   - `~/.dsh/profiles/web/node_modules/dsh-plugin-config-backup/` 是否存在且含 `cordis.patch.yml`（缺了就是 `files` 字段没打包进来）；
   - `~/.dsh/profiles/web/cordis.patch.yml` 有没有 `- id: config-backup`。补齐后**必须重启 dsh**（面板与工具才会出现在新进程里）。
5. **改周期 / 保留数 / 目录 / include / exclude** → 只改 profile 补丁层里那段的 `config:`，然后重启；不要改插件仓库里的文件，也不要手写 profile 的 `package.json`。
6. **换机器 / 导出导入**（用户说"搬到另一台机器""复用那台机器的配置"）：
   1. 旧机：`config_backup_export`（不带 id 就导出最新一份）→ 返回 `file`（`.tar.gz`）。告诉用户这个路径，让他拷走。
   2. 新机：装好 dsh 与插件 → `config_backup_import`（`archive` 传路径）→ 记录里多一条 `kind: import`。
   3. 新机：再 `config_backup_restore`（`id` 用刚导入的 id，`confirm: true`）→ 重启 dsh。
   同一个包重复导入会报 `this archive is already imported as <id>`，不是错误，直接跳过。
7. **还原某份备份**（会覆盖，先确认）：优先调 `config_backup_restore`（`confirm: true` 必须由用户明确同意后再传）。它会先把当前配置存成 `pre-restore` 快照，返回里的 `safetyId` 就是回滚点——告诉用户"要撤回就再还原 safetyId"。
   只覆盖配置清单内的条目（AGENTS.md/settings.yaml/cordis.patch.yml/.env/.credentials.yaml/skills/storages 等）；`blocked` 非空说明有文件被拒绝覆盖（不属于清单），把这几个文件名报给用户，别说"已全部还原"。
   没有工具时手动：
   ```bash
   ls -dt ~/.dsh/backups/*/ | head -5      # 挑快照
   mv ~/.dsh ~/.dsh.broken                # 旧配置挪走
   cp -R ~/.dsh.broken/backups/<id> ~/.dsh
   cp -R ~/.dsh.broken/profiles ~/.dsh/profiles   # 依赖目录不必重装
   ```
   然后重启。`~/.dsh.broken` 留着，确认没问题再让用户自己删。
8. **排查"没备份 / 没通知"**：看 `status` 里的 `enabled`、`nextRunAt`；macOS 通知靠 `osascript`，用户关了 DSH 的系统通知权限就不弹（面板和 toast 仍工作）；Host 启动后的补备份在 60 秒后才跑。

## 坑

- `dsh plugin --profile web add <dir>` 只装包，**不会**改 `dsh.profile.bundles`，也不会写 `cordis.patch.yml`。
- 用 `file:` 规格安装时 pnpm 按 `files` 字段发 tarball，漏了 `cordis.patch.yml` 会报 `failed to read overlay ... ENOENT` 且 profile 拒绝加载该包。
- 快照是完整副本（默认约 12 MB、700+ 文件），别把 `sessions/`、`attachments/` 也 include 进去。
- `.env`、`.credentials.yaml` 会被一起备份、也会进导出包，提醒用户别把备份目录或 `.tar.gz` 同步到公开仓库/共享链接。
- `profiles/` 不进快照也不进包：新机器要自己装依赖（`dsh plugin add` + 手改 `dsh.profile.bundles`）。
- 快照 id 可能出现 `-1` 后缀（同一秒两次备份），这是合法 id，能列能还原。
