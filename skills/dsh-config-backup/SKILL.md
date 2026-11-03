---
name: dsh-config-backup
description: 用户要"备份一下 dsh 配置""看看都有哪些备份""恢复某份备份""怎么改备份周期/保留份数/备份了哪些文件""备份失败/没有备份记录/通知没弹"时使用。办法是调用 dsh-plugin-config-backup 提供的 config_backup_run / config_backup_list 工具，或走侧边栏「备份」面板；信息不够时读 ~/.dsh/backups/.backup.json 与 profile 补丁层里 config-backup 条目的 config。
whenToUse: 与 dsh 配置备份相关的任何请求——立即备份、列备份、恢复、改周期、改保留数、改备份目录或 include/exclude、排查备份没跑/没通知/目录不存在/快照被清理。
---

# dsh 配置备份（dsh-config-backup）

插件：[dsh-plugin-config-backup](https://github.com/suveng/dsh-plugin-config-backup)（Cordis 插件，Host 服务名 `backups`，Remote 命名空间 `backups`）。
入口三处：侧边栏「备份」面板、对话工具 `config_backup_run` / `config_backup_list`、设置页 → 插件 → 备份。

## 定数的东西（不要现算或猜）

- 配置根：`$DSH_HOME`，未设置时为 `~/.dsh`。
- 备份目录：配置 `targetDir`，空则 `$DSH_HOME/backups`；快照名 `YYYYMMDD-HHmmss`（本地时间，已存在时追加 `-N`）。
- 每份快照内有 `.backup.json`：`{id,home,kind,files,bytes,errors,createdAt,startedAt}`。
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
6. **恢复某份备份**：先让用户确认（会覆盖配置），再：
   ```bash
   ls -dt ~/.dsh/backups/*/ | head -5      # 挑快照
   mv ~/.dsh ~/.dsh.broken                # 旧配置挪走
   cp -R ~/.dsh.broken/../.dsh/backups/<id> ~/.dsh
   cp -R ~/.dsh.broken/profiles ~/.dsh/profiles   # 依赖目录不必重装
   ```
   然后重启。`~/.dsh.broken` 留着，确认没问题再让用户自己删。
7. **排查"没备份 / 没通知"**：看 `status` 里的 `enabled`、`nextRunAt`；macOS 通知靠 `osascript`，用户关了 DSH 的系统通知权限就不弹（面板和 toast 仍工作）；Host 启动后的补备份在 60 秒后才跑。

## 坑

- `dsh plugin --profile web add <dir>` 只装包，**不会**改 `dsh.profile.bundles`，也不会写 `cordis.patch.yml`。
- 用 `file:` 规格安装时 pnpm 按 `files` 字段发 tarball，漏了 `cordis.patch.yml` 会报 `failed to read overlay ... ENOENT` 且 profile 拒绝加载该包。
- 快照是完整副本（默认约 12 MB、700+ 文件），别把 `sessions/`、`attachments/` 也 include 进去。
- `.env`、`.credentials.yaml` 会被一起备份，提醒用户备份目录别同步到公开仓库。
