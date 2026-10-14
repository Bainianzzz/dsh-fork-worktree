# dsh-fork-worktree

给 dsh 侧边栏的**工作区行**加两个按钮（在 `…` 和 `+` 之间，fork 在左、垃圾桶在右）：

- **fork**：确认后基于该工作区所在的 git 仓库建一个新 worktree，并把 worktree 目录注册成新的 dsh 工作区（并在新工作区里开会话）。
- **垃圾桶**：确认后删掉该工作区的目录，并移除它的登记。

两个按钮都**不会**在点击时直接动手，都必须先在弹窗里确认。

## 位置与实现

- 两个按钮都只在行 hover 时显示（和 `+` 一样）。
- dsh 的工作区行**没有** slot 扩展点（`…`、`+` 都是 ui-workspace 写死的行内 UI），所以按钮是通过 `shell.overlay` 里挂一个 React 组件、再用 `createPortal` portal 进行动区的（见 `client.js` 的 `WorkspaceRowActions`）。用 `data-row-key="workspace:<id>"` 找行、`data-slot="sidebar.workspaces"` 作为只监听侧边栏的 MutationObserver 根（不监听整帧，流式输出不会触发重扫）。
- 图标取自 [Lucide](https://lucide.dev)（ISC）：fork 用 `git-fork`（v1.57.0），垃圾桶用 `trash` 的无竖线画法（v0.400.0）、描边 1.8 —— v1.57.0 里 `trash` 与 `trash-2` 的 path 相同，那两道内线在 16px 下挤成一块、看着比 fork 粗，所以取无竖线版本并把描边调到 1.8，两个图标视觉粗细一致（约 1.2px）。都按原样的 24 单位 viewBox、`currentColor`、round caps/joins 内联在 `client.js` 里（本 bundle 不引入图标包），显示尺寸 16px。
- 风险：dsh 改版若改了这两个 DOM 钩子，按钮会消失（不会报错）；那时需要跟着改选择器。

## fork 流程

1. 点 fork：**只弹确认框**。
2. 确认 → `POST dsh-fork-worktree/fork {source, init:false}`（Host 的 `forkRoute`）：
   - 是 git 仓库 → `git worktree add -b wt/<label> <仓库名>-wt-<label> HEAD`，注册工作区。
   - 不是 git 仓库 → 返回 `not-a-git-repo`，同一个弹窗切成"初始化"模式。
3. 初始化模式确认 → `init:true`：`git init` + 把目录当前内容提交成第一个提交（空目录则空提交），再建 worktree。
4. 成功 → `ctx.workspaces.create({path})`（幂等，把新工作区并进 Client 模型）→ `ctx.uiWorkspace.startSession(id)` 在新工作区打开会话 → toast 显示路径。

`/fork-worktree [name] [--init]` 命令是同一套逻辑的第二个入口，可在该工作区的会话里手敲。

## 垃圾桶流程与删除语义

1. 点垃圾桶：**只弹确认框**，写明将删除的确切路径（还会写明会话记录保留）。
2. 确认 → `POST dsh-fork-worktree/remove {source, force:false}`（Host 的 `removeRoute` → `removeWorkspaceFolder`）：
   - **linked worktree**（`.git` 是文件）→ 走 `git worktree remove`，仓库的 `worktrees/` 元数据跟着走（不留脏数据）。
   - 有未提交修改或未跟踪文件 → 返回 `worktree-dirty`，弹窗切成"强制删除"模式，再确认才 `--force`。
   - 其他目录 → 直接 `rm -rf`。
   - 删完移除工作区登记；即使这一步失败，2 秒后的扫描也会把登记收掉。
3. 护栏：拒绝删除 `$HOME` 和文件系统根；目录不存在/不是目录都返回明确错误码。
4. 删除**故意没有**命令入口：命令会默认取当前会话的工作区，删掉自己正在用的目录不该只是一条命令的距离。

## worktree 命名

- 目录：与仓库根同级，`<仓库名>-wt-<label>`；`label` 是 `<name>`（若给）或 6 位随机 hex。
- 分支：`wt/<label>`，基于当前 HEAD。

## 工作区自动消失

Host 每 2 秒扫一次注册表（`watchRemovedWorktrees`）：

- 目录存在且 `.git` 是**文件**（linked worktree）→ 记为跟踪对象。
- 被跟踪对象连续两次扫描都目录缺失 → 静默删除该工作区注册（不动文件和会话，不报错）。
- 进程重启后不丢：目录已消失、但名字是 `*-wt-<6位hex>`，或同级还有同名仓库目录时，同样会被清掉。
- 不动普通目录、不动 `bg-switcher--worktrees/xxx--worktree` 这类别的命名。

## 开发迭代

改 Host 侧（`impl.js`）后，让这一行重新加载即可，不用重启 dsh：插件页把 `fork-worktree` 关掉再打开，或调 `plugin_manager` 的 `set_plugin`（`target: include:fork-worktree`，先 `enabled:false` 再 `enabled:true`）。

原理：ES 模块按解析后的 URL 缓存，所以 Loader 那一行导入的 `index.js` 是个极小且不再改动的壳，它的 `apply` 里用 `?load=<时间戳>` 动态 import 真正的实现 `impl.js`——每次重新加载都拿到新副本。

`client.js` 改了要刷新页面（F5）才生效。bundle 是 `link:` 安装时，`pnpm` 层面不用重装。

`node verify-host.mjs`：不依赖 dsh 的 Host 侧验证（61 项），覆盖 worktree 创建/分支/初始化、两种删除（worktree / 普通目录）、dirty 拒绝与强删、路径护栏、两个路由的信任校验与 JSON 契约、以及自动清理的各分支。临时仓库建在系统临时目录并在结束时删除，不会污染本目录。

## 安装

```sh
dsh plugin add github:Bainianzzz/dsh-fork-worktree
```

或者用 GitHub Release 上的预构建 tarball：

```sh
dsh plugin add https://github.com/Bainianzzz/dsh-fork-worktree/releases/latest/download/dsh-fork-worktree.tgz
```

装好后侧边栏的工作区行 hover 即出现两个按钮。本插件只用 Node 内置模块，不需要构建授权。

## 文件

- `index.js`：包入口，也是 Loader 那一行导入的壳（`name`/`inject`/`apply`）。
- `impl.js`：Host 实现——`createWorktreeFork`、`removeWorkspaceFolder`、两个路由、`/fork-worktree` 命令、工作区清理扫描。
- `client.js`：浏览器侧——工作区行两个按钮（React portal）、四种弹窗、toast。
- `cordis.patch.yml`：bundle 的 patch，插入 id 为 `fork-worktree` 的这一行。
- `verify-host.mjs`：Host 侧离线验证脚本。
- 依赖：只用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 包，所以 `dependencies` 与 `peerDependencies` 都是空的。

