# dsh-fork-worktree

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

给 dsh 侧边栏的工作区行加两个按钮（位于 `…` 和 `+` 之间）：

- **fork**：基于该工作区的 git 仓库新建 worktree，注册为新工作区并在其中打开会话。
- **垃圾桶**：删除该工作区的 worktree，并移除工作区登记。

两个操作都必须先在弹窗中确认，点击按钮本身不会直接动手。

## 安装

在侧栏的**插件**面板里点**添加插件**，填入 `github:Bainianzzz/dsh-fork-worktree`，安装完成后点**立即启用**。

安装并启用后 hover 工作区行即可看到按钮。

> 更多安装方式请查看 [Release 页](https://github.com/Bainianzzz/dsh-fork-worktree/releases)

## 用法

### fork

1. 点击 fork，只弹出确认框。面板里列出两种创建方式，底部三个按钮：「取消｜创建 git worktree｜复制并创建 worktree」：
   - **创建 git worktree**：只检出已提交的内容；未提交的修改、未跟踪文件、被 `.gitignore` 忽略的内容都留在源目录。
   - **复制并创建 worktree**：检出后把 worktree 缺失的文件复制进去，包括未跟踪文件与被忽略的内容（`node_modules`、`.env`、构建产物、配置文件等）。已跟踪的文件保留 HEAD 版本，相对软链按原样保留。
2. 点任一创建按钮后：
   - 目录是 git 仓库 → 在仓库同级创建 `<仓库名>-wt-<label>`，分支为 `wt/<label>`，基于当前 HEAD；复制方式下补齐缺失文件；并注册为新工作区。
   - 目录不是 git 仓库 → 弹窗切换为“初始化”模式（保留已选方式）；再次确认后执行 `git init`，把目录当前内容提交为首个提交（空目录则空提交），再创建 worktree。
3. 成功后在新工作区打开会话，并用 toast 显示路径；复制方式下附带复制了多少项。

复制失败时，刚创建的 worktree 与分支一并撤销。

也可在该工作区的会话里执行：

```sh
/fork-worktree [name] [--init] [--copy]
```

省略 `name` 时使用 6 位随机 hex 作为 `label`；`--copy` 对应上面的“复制并创建 worktree”。

### 删除

1. 点击垃圾桶，确认框会写明将删除的确切路径，并说明会话记录会保留。
2. 确认后通过 `git worktree remove` 删除该 worktree，仓库的 worktree 元数据一并清理，并移除工作区登记。
3. 有未提交修改或未跟踪文件时拒绝删除，弹窗切换为“强制删除”模式，再次确认才执行。
4. 护栏：拒绝删除 `$HOME` 和文件系统根目录。

删除刻意没有命令入口，避免一条命令误删当前会话正在使用的目录。

### 自动清理

worktree 目录被外部删除后，对应的工作区登记会自动移除；普通目录和不符合命名规则的目录不受影响。
