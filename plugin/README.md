# dsh-fork-worktree

给 dsh 侧边栏的**工作区行**加一个 fork 按钮：点它 → 确认弹窗 → 基于该工作区所在的 git 仓库创建一个新的 worktree，并把 worktree 目录注册成一个新的 dsh 工作区（并直接在新工作区里开会话）。

## 位置与实现

- 按钮插在工作区行的 `…` 和 `+` 之间，和 `+` 一样只在行 hover 时显示。
- dsh 的工作区行**没有** slot 扩展点（`…`、`+` 都是 ui-workspace 写死的行内 UI），所以按钮是通过 `shell.overlay` 里挂一个 React 组件、再用 `createPortal` 把按钮 portal 进行动区的（见 `client.js` 的 `WorkspaceForkHost`）。用 `data-row-key="workspace:<id>"` 找行、用 `data-slot="sidebar.workspaces"` 作为只监听侧边栏的 MutationObserver 根，不监听整帧，避免流式输出时反复扫描。
- 风险：dsh 改版若改了这两个 DOM 钩子，按钮会消失（不会报错）；那时需要跟着改选择器。

## 交互

1. 点 fork 图标：**只弹确认框**，不做任何创建。
2. 确认后：`POST dsh-fork-worktree/fork {source, init:false}`（Host 里 `forkRoute`）。
   - 是 git 仓库 → `git worktree add -b wt/<label> <repo>-wt-<label> HEAD`，注册工作区。
   - 不是 git 仓库 → 返回 `not-a-git-repo`，同一个弹窗切换成"初始化"模式。
3. 初始化模式确认后：`init:true` → `git init` + 把目录当前内容提交成第一个提交（空目录则空提交），再建 worktree。
4. 成功后：`ctx.workspaces.create({path})`（幂等，把新工作区并进 Client 模型）→ `ctx.uiWorkspace.startSession(id)` 直接在新工作区打开会话 → 右上角 toast 显示路径。

`/fork-worktree [name] [--init]` 命令是同一套逻辑的第二个入口，可在该工作区的会话里手敲。

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

改 Host 侧（`impl.js`）后，让这一行重新加载即可，不用重启 dsh：在插件页把 `fork-worktree` 关掉再打开，或调 `plugin_manager` 的 `set_plugin`（`target: include:fork-worktree`，先 `enabled:false` 再 `enabled:true`）。

原理：ES 模块按解析后的 URL 缓存，所以 Loader 那一行指的不是会被缓存的包名，而是

- `entry.js`：极小且不再改动的壳，`apply` 里用 `?load=<时间戳>` 动态 import 真正的实现；
- `impl.js`：Host 实现，每次重新加载都拿到新副本。

`client.js` 改了要刷新页面（F5）才生效。`npm`/`pnpm` 层面不需要重装：bundle 是 `link:` 安装的。

`node verify-host.mjs`：不依赖 dsh 的 Host 侧验证，覆盖 worktree 创建/分支/初始化、路由的信任校验与 JSON 契约、以及自动清理的各种分支。

## 装到哪里

- bundle：`@local/dsh-fork-worktree`，以 `link:` 方式装在 web profile（`~/.dsh/profiles/web`），行 id `fork-worktree`。
- 包内文件：`entry.js`（Loader 行，壳）、`impl.js`（Host 实现）、`client.js`（浏览器侧）、`index.js`（包入口，只做 re-export）。
- `cordis.patch.yml` 里那一行按**绝对路径**指向 `entry.js`（见文件内注释）；移动这个目录需要同步改这一行并重装 bundle。
