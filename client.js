/**
 * Client half of the `@bainianzzz/dsh-fork-worktree` bundle.
 *
 * Two buttons on every *Workspace* row of the sidebar's workspace browser — fork
 * (create a worktree of that Workspace's repository and register it) and trash
 * (delete that Workspace's directory and drop its registration) — plus one
 * dialog and one toast.
 *
 * The workspace row is not a slot host: DSH renders its "…" menu and its "+"
 * new-session button as private row chrome with no extension point, so this
 * bundle mounts its buttons into that row's action strip through a React portal
 * and re-scans on DOM mutations. The strip is the last element child of the row
 * carrying `data-row-key="workspace:<id>"`, the buttons are inserted directly
 * before the "+", and the host hides the whole strip until the row is hovered,
 * so the buttons inherit that behavior.
 *
 * No click ever acts: each one opens the dialog first. The fork dialog explains
 * both creation modes and offers one button per mode — a plain `git worktree
 * add` checkout, or that checkout plus every path the source has and the
 * checkout does not (`node_modules`, `.env`, anything untracked or ignored) —
 * and the clicked button posts the Workspace's directory to the fork route,
 * which creates the worktree and registers the Workspace; this half then adopts
 * that Workspace into the Client model and opens a Session in it. Confirming the
 * removal posts to the remove route; a worktree that still holds uncommitted
 * content answers `worktree-dirty`, and the dialog reopens in its force mode
 * instead of discarding work.
 *
 * Controls are hand-written against theme tokens; the markup and CSS follow the
 * host's `iconButton`, `Modal`, `Toast`, and destructive `Button` and share only
 * the `--dsw-*` tokens.
 */
window.__ModuleLoader__.load({
	id: '@bainianzzz/dsh-fork-worktree',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		const createPortal = ReactDOM.createPortal ?? ReactDOM.default?.createPortal;

		/** Dictionary namespace owned by this plugin. */
		const NS = 'fork-worktree';

		/** Host routes, relative so a mount prefix keeps working. */
		const FORK_ROUTE = 'dsh-fork-worktree/fork';
		const REMOVE_ROUTE = 'dsh-fork-worktree/remove';

		/** Workspace rows carry this prefix in `data-row-key`. */
		const ROW_SELECTOR = '[data-row-key^="workspace:"]';

		/** The renderer's stable anchor for the sidebar's browsing region. */
		const OUTLET_SELECTOR = '[data-slot="sidebar.workspaces"]';

		/** Marks the container this bundle injects into one row's action strip. */
		const CONTAINER_ATTRIBUTE = 'data-dsh-fork-worktree';

		/** How long a toast stays before it dismisses itself, matching the host's banner. */
		const TOAST_HOLD_MS = 3200;

		/** Dialog steps: the fork confirmation, the initialize retry, and the two removals. */
		const CONFIRM = 'confirm';
		const INITIALIZE = 'initialize';
		const REMOVE = 'remove';
		const REMOVE_FORCE = 'remove-force';

		/** Which operation a toast reports. */
		const FORK = 'fork';

		const zh = {
			'action.fork': '用新 worktree 创建工作区',
			'action.remove': '删除工作区文件夹',
			'confirm.title': '新建 worktree 工作区',
			'confirm.desc': '将基于 {path} 所在的仓库创建一个新的 git worktree，并把该 worktree 注册为一个新的 dsh 工作区。',
			'confirm.gitAction': '创建 git worktree',
			'confirm.copyAction': '复制并创建 worktree',
			'confirm.busyGit': '正在创建 worktree…',
			'confirm.busyCopy': '正在创建 worktree 并复制文件…',
			'mode.git.title': '仅 git worktree',
			'mode.git.desc': '只含已提交内容 · 不带未提交改动、未跟踪文件、.gitignore 忽略项',
			'mode.copy.title': '复制全部文件',
			'mode.copy.desc': '创建 git worktree，并额外复制未跟踪文件与 .gitignore 忽略项',
			'init.title': '该目录不是 git 仓库',
			'init.desc': '无法为 {path} 创建 worktree。可以先用 git init 把它初始化为仓库（把该目录当前的内容提交为第一个提交），再创建 worktree。',
			'init.copyHint': '初始化之后，被 .gitignore 忽略的文件（node_modules、.env 等）也会被复制到新 worktree。',
			'init.action': '初始化并创建 worktree',
			'init.busy': '正在初始化并创建 worktree…',
			'remove.title': '删除工作区文件夹',
			'remove.desc': '将删除文件夹 {path} 及其全部内容，并移除该工作区的登记。会话记录会保留，删除的内容无法恢复。',
			'remove.action': '删除文件夹',
			'remove.busy': '正在删除…',
			'removeForce.title': '文件夹里有未提交的内容',
			'removeForce.desc': '{path} 里有未提交的修改或未跟踪文件，普通删除会被 git 拒绝。强制删除会把这些内容一并丢弃。',
			'removeForce.action': '强制删除',
			'removeForce.busy': '正在强制删除…',
			'cancel': '取消',
			'toast.forked': '已创建 worktree 工作区：{path}',
			'toast.forkedCopied': '已创建 worktree 工作区：{path}（复制了 {count} 项）',
			'toast.forkFailed': '创建 worktree 失败：{message}',
			'toast.removed': '已删除工作区文件夹：{path}',
			'toast.removeFailed': '删除失败：{message}',
		};
		const en = {
			'action.fork': 'Create a workspace on a new worktree',
			'action.remove': 'Delete the workspace folder',
			'confirm.title': 'New worktree workspace',
			'confirm.desc': 'A new git worktree will be created from the repository that owns {path}, and that worktree will be registered as a new dsh workspace.',
			'confirm.gitAction': 'Create a git worktree',
			'confirm.copyAction': 'Copy and create a worktree',
			'confirm.busyGit': 'Creating the worktree…',
			'confirm.busyCopy': 'Creating the worktree and copying files…',
			'mode.git.title': 'git worktree only',
			'mode.git.desc': 'Committed content only · no uncommitted changes, untracked files, or .gitignore entries',
			'mode.copy.title': 'Copy all files',
			'mode.copy.desc': 'Creates the git worktree and also copies untracked files and .gitignore entries',
			'init.title': 'This directory is not a git repository',
			'init.desc': "No worktree can be created for {path} yet. Initialize it as a repository first (git init, committing the directory's current content as its first commit), then create the worktree.",
			'init.copyHint': 'Once initialized, files ignored by .gitignore (node_modules, .env, …) are copied into the new worktree too.',
			'init.action': 'Initialize and create worktree',
			'init.busy': 'Initializing and creating the worktree…',
			'remove.title': 'Delete the workspace folder',
			'remove.desc': 'The folder {path} and everything inside it will be deleted, and the workspace registration will be dropped. Session logs are kept; deleted content cannot be recovered.',
			'remove.action': 'Delete folder',
			'remove.busy': 'Deleting…',
			'removeForce.title': 'The folder holds uncommitted content',
			'removeForce.desc': '{path} contains modified or untracked files, so git refuses an ordinary removal. A forced removal discards that content with the folder.',
			'removeForce.action': 'Delete anyway',
			'removeForce.busy': 'Deleting anyway…',
			'cancel': 'Cancel',
			'toast.forked': 'Created a worktree workspace: {path}',
			'toast.forkedCopied': 'Created a worktree workspace: {path} ({count} items copied)',
			'toast.forkFailed': 'Creating the worktree failed: {message}',
			'toast.removed': 'Deleted the workspace folder: {path}',
			'toast.removeFailed': 'Deleting the folder failed: {message}',
		};

		const css = `
.dshForkWtContainer{display:inline-flex;align-items:center;gap:10px;flex:none}
.dshForkWtButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshForkWtButton:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshForkWtButton:disabled{opacity:.5;cursor:default}
.dshForkWtMask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dshForkWtMask::after{content:'';position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshForkWtDialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;width:min(480px,100%);max-height:100%;overflow:auto;padding:22px 24px 24px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.dshForkWtDialog:focus{outline:none}
.dshForkWtTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dshForkWtDesc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshForkWtStatus{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshForkWtModes{display:flex;flex-direction:column;gap:10px}
.dshForkWtMode{display:flex;flex-direction:column;gap:2px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l3)}
.dshForkWtModeTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshForkWtModeDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshForkWtActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}
.dshForkWtAction{box-sizing:border-box;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dshForkWtAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshForkWtAction:disabled{cursor:not-allowed;opacity:.4}
.dshForkWtActionPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshForkWtActionPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshForkWtActionGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dshForkWtActionGhost:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshForkWtActionDanger:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.dshForkWtToast{position:fixed;top:40px;left:50%;z-index:1100;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;pointer-events:none;transform:translateX(-50%)}
.dshForkWtDot{flex:none;width:8px;height:8px;border-radius:50%}
.dshForkWtDotOk{background:var(--dsw-alias-state-success-primary)}
.dshForkWtDotError{background:var(--dsw-alias-state-error-primary)}
.dshForkWtToastText{min-width:0;overflow-wrap:anywhere}
`;

		/** The bundle's one stylesheet, rendered by each root component so unmounting removes it. */
		function Styles() {
			return h('style', { 'data-dsh-plugin': NS }, css);
		}

		/**
		 * Minimal `useSyncExternalStore` source. Slot `hooks` faces accept any
		 * `{ getSnapshot, subscribe }` pair, which is exactly the shape here.
		 */
		function observable(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set: (next) => {
					value = next;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/**
		 * Fork glyph: the geometry of Lucide's `git-fork` (Lucide v1.57.0, ISC),
		 * inlined because this bundle imports no icon package. Lucide's own
		 * presentation attributes are kept — 24-unit viewBox, `currentColor`,
		 * round caps and joins, 2-unit stroke.
		 */
		function ForkIcon() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: 16,
					height: 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				h('circle', { cx: 12, cy: 18, r: 3 }),
				h('circle', { cx: 6, cy: 6, r: 3 }),
				h('circle', { cx: 18, cy: 6, r: 3 }),
				h('path', { d: 'M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9' }),
				h('path', { d: 'M12 12v3' }),
			);
		}

		/**
		 * Trash glyph: the geometry of Lucide's `trash` (Lucide v0.400.0, ISC) —
		 * lid, body and handle, without the two interior slats that `trash-2`
		 * adds. Lucide v1.57.0 gives both names the same paths, and at 16px those
		 * slats sit about a pixel apart and make the can read heavier than the
		 * fork beside it, so this is the slat-free can.
		 *
		 * Its stroke is 1.8 rather than Lucide's 2: one glyph is drawn from
		 * curves and the other from straight lines, and at 16px the straight
		 * horizontals survive antialiasing better, so an equal declared width
		 * still renders as different weight. Both land at about 1.2px.
		 */
		function TrashIcon() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: 16,
					height: 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				h('path', { d: 'M3 6h18' }),
				h('path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }),
				h('path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }),
			);
		}

		/** One row icon button, shared by both actions. */
		function RowIconButton({ label, onClick, children }) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dshForkWtButton',
					'aria-label': label,
					title: label,
					onClick: (event) => {
						event.stopPropagation();
						onClick();
					},
				},
				children,
			);
		}

		/** Fork button of one Workspace row, portalled into that row's action strip. */
		function WorkspaceForkButton({ workspaceId, forkWorkspace, t }) {
			const label = t('action.fork');
			return h(RowIconButton, { label, onClick: () => forkWorkspace(workspaceId) }, h(ForkIcon));
		}

		/** Trash button of one Workspace row, to the right of the fork button. */
		function WorkspaceRemoveButton({ workspaceId, removeWorkspace, t }) {
			const label = t('action.remove');
			return h(RowIconButton, { label, onClick: () => removeWorkspace(workspaceId) }, h(TrashIcon));
		}

		/**
		 * The `shell.overlay` entry that keeps both buttons mounted in every
		 * Workspace row.
		 *
		 * It watches the sidebar's own slot outlet (`data-slot`, the renderer's
		 * stable anchor) rather than the whole frame, so a streaming Conversation
		 * elsewhere in the frame costs no scans, and it re-uses the container it
		 * already injected, so a re-render of the row neither duplicates the
		 * buttons nor loses them.
		 */
		function WorkspaceRowActions({ forkWorkspace, removeWorkspace, t }) {
			const [targets, setTargets] = React.useState([]);
			React.useEffect(() => {
				let frame = 0;
				let observed;
				const observer = new MutationObserver((records) => {
					/* Our own button rendering must not schedule another scan. */
					const foreign = records.some((record) => {
						const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
						return node === null || node.closest(`[${CONTAINER_ATTRIBUTE}]`) === null;
					});
					if (foreign) schedule();
				});
				const collect = () => {
					frame = 0;
					const outlet = document.querySelector(OUTLET_SELECTOR);
					const scope = outlet ?? document;
					/* The outlet mounts after this entry in a cold frame; follow it then. */
					if (observed !== scope) {
						observer.disconnect();
						observer.observe(scope === document ? document.body : scope, { childList: true, subtree: true });
						observed = scope;
					}
					const next = [];
					for (const row of scope.querySelectorAll(ROW_SELECTOR)) {
						const workspaceId = String(row.getAttribute('data-row-key') ?? '').slice('workspace:'.length);
						if (workspaceId === '') continue;
						const strip = row.lastElementChild;
						if (strip === null) continue;
						let container = strip.querySelector(`[${CONTAINER_ATTRIBUTE}]`);
						if (container === null) {
							container = document.createElement('span');
							container.setAttribute(CONTAINER_ATTRIBUTE, '');
							container.className = 'dshForkWtContainer';
							/* Immediately before the row's own "+" new-session button. */
							const siblings = [...strip.children];
							const last = siblings[siblings.length - 1];
							if (last === undefined) strip.appendChild(container);
							else strip.insertBefore(container, last);
						}
						next.push({ workspaceId, container });
					}
					setTargets((previous) =>
						previous.length === next.length &&
						previous.every((target, index) => target.container === next[index].container && target.workspaceId === next[index].workspaceId)
							? previous
							: next,
					);
				};
				function schedule() {
					if (frame === 0) frame = requestAnimationFrame(collect);
				}
				observer.observe(document.body, { childList: true, subtree: true });
				observed = document;
				collect();
				return () => {
					observer.disconnect();
					if (frame !== 0) cancelAnimationFrame(frame);
					for (const container of document.querySelectorAll(`[${CONTAINER_ATTRIBUTE}]`)) container.remove();
				};
			}, []);
			return h(
				React.Fragment,
				null,
				h(Styles),
				createPortal === undefined
					? null
					: targets.map((target) =>
							createPortal(
								h(
									React.Fragment,
									null,
									h(WorkspaceForkButton, { workspaceId: target.workspaceId, forkWorkspace, t }),
									h(WorkspaceRemoveButton, { workspaceId: target.workspaceId, removeWorkspace, t }),
								),
								target.container,
								target.workspaceId,
							),
						),
			);
		}

		/** The one dialog: a confirmation, the mode question, and the questions after a refusal. */
		function WorkspaceActionDialog({ useWorkspaceRequest, settleWorkspaceRequest, confirmWorkspaceRequest, t }) {
			const request = useWorkspaceRequest((pending) => pending);
			if (request === null) return null;
			return h(WorkspaceActionDialogBody, {
				key: request.workspaceId,
				request,
				settle: settleWorkspaceRequest,
				confirm: confirmWorkspaceRequest,
				t,
			});
		}

		/** Prefix of the dictionary keys driving one step, and whether it destroys. */
		function modePresentation(mode) {
			switch (mode) {
				case INITIALIZE:
					return { prefix: 'init', danger: false };
				case REMOVE:
					return { prefix: 'remove', danger: true };
				case REMOVE_FORCE:
					return { prefix: 'removeForce', danger: true };
				default:
					return { prefix: 'confirm', danger: false };
			}
		}

		/**
		 * The single action and busy keys of each step that has one primary button.
		 * The confirmation is absent on purpose: it draws one button per creation
		 * mode and has two busy variants, so it never asks for a `confirm.action`
		 * or `confirm.busy` key.
		 */
		const STEP_KEYS = {
			[INITIALIZE]: { action: 'init.action', busy: 'init.busy' },
			[REMOVE]: { action: 'remove.action', busy: 'remove.busy' },
			[REMOVE_FORCE]: { action: 'removeForce.action', busy: 'removeForce.busy' },
		};

		/**
		 * What each of the confirmation's two creation buttons puts into the new
		 * worktree, in the order those buttons appear: a plain checkout, then the
		 * checkout with the source's missing paths.
		 */
		function CreationModes({ t }) {
			const modes = [
				{ key: 'git', title: 'mode.git.title', desc: 'mode.git.desc' },
				{ key: 'copy', title: 'mode.copy.title', desc: 'mode.copy.desc' },
			];
			return h(
				'div',
				{ className: 'dshForkWtModes' },
				modes.map((mode) =>
					h(
						'div',
						{ key: mode.key, className: 'dshForkWtMode' },
						h('span', { className: 'dshForkWtModeTitle' }, t(mode.title)),
						h('span', { className: 'dshForkWtModeDesc' }, t(mode.desc)),
					),
				),
			);
		}

		/** One pending request's dialog; its in-flight state dies with it. */
		function WorkspaceActionDialogBody({ request, settle, confirm, t }) {
			const [busy, setBusy] = React.useState(false);
			/* Which creation the in-flight request used, so the busy line can name the copy. */
			const [pendingCopy, setPendingCopy] = React.useState(false);
			const primary = React.useRef(null);
			const confirming = request.mode === CONFIRM;
			React.useEffect(() => {
				/* Each step has its own primary button; keep the keyboard on it. */
				primary.current?.focus();
			}, [request.mode]);
			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key === 'Escape' && !busy) settle();
				};
				window.addEventListener('keydown', onKeyDown);
				return () => window.removeEventListener('keydown', onKeyDown);
			}, [busy, settle]);
			const { prefix, danger } = modePresentation(request.mode);
			/* Unknown steps fall back to the fork labels instead of a missing key. */
			const stepKeys = STEP_KEYS[request.mode] ?? { action: 'confirm.gitAction', busy: 'confirm.busyGit' };
			const busyText = confirming ? t(pendingCopy ? 'confirm.busyCopy' : 'confirm.busyGit') : t(stepKeys.busy);
			/* The chosen creation button both decides the mode and starts the request. */
			const run = (copy) => {
				if (busy) return;
				setPendingCopy(copy);
				setBusy(true);
				Promise.resolve(confirm(request.workspaceId, request.mode, copy)).finally(() => setBusy(false));
			};
			return h(
				'div',
				{ className: 'dshForkWtMask' },
				h(Styles),
				h(
					'div',
					{
						className: 'dshForkWtDialog',
						role: 'dialog',
						'aria-modal': true,
						'aria-label': t(`${prefix}.title`),
						tabIndex: -1,
					},
					h('p', { className: 'dshForkWtTitle' }, t(`${prefix}.title`)),
					h('p', { className: 'dshForkWtDesc' }, t(`${prefix}.desc`, { path: request.source })),
					request.mode === INITIALIZE && request.copy ? h('p', { className: 'dshForkWtDesc' }, t('init.copyHint')) : null,
					confirming ? h(CreationModes, { t }) : null,
					busy ? h('p', { className: 'dshForkWtStatus', role: 'status' }, busyText) : null,
					h(
						'div',
						{ className: 'dshForkWtActions' },
						h(
							'button',
							{
								type: 'button',
								className: 'dshForkWtAction dshForkWtActionGhost',
								disabled: busy,
								onClick: () => {
									if (!busy) settle();
								},
							},
							t('cancel'),
						),
						confirming
							? [
									h(
										'button',
										{
											key: 'git',
											type: 'button',
											ref: primary,
											className: 'dshForkWtAction dshForkWtActionPrimary',
											disabled: busy,
											onClick: () => run(false),
										},
										t('confirm.gitAction'),
									),
									h(
										'button',
										{
											key: 'copy',
											type: 'button',
											className: 'dshForkWtAction',
											disabled: busy,
											onClick: () => run(true),
										},
										t('confirm.copyAction'),
									),
								]
							: h(
									'button',
									{
										type: 'button',
										ref: primary,
										className: `dshForkWtAction ${danger ? 'dshForkWtActionDanger' : 'dshForkWtActionPrimary'}`,
										disabled: busy,
										onClick: () => run(request.copy === true),
									},
									t(stepKeys.action),
								),
					),
				),
			);
		}

		/** The outcome banner for one finished attempt. */
		function WorkspaceActionToast({ useWorkspaceToast, dismissWorkspaceToast, t }) {
			const toast = useWorkspaceToast((pending) => pending);
			React.useEffect(() => {
				if (toast === null) return undefined;
				const timer = setTimeout(dismissWorkspaceToast, TOAST_HOLD_MS);
				return () => clearTimeout(timer);
			}, [toast === null ? 0 : toast.seq]);
			if (toast === null) return null;
			const removed = toast.action !== FORK;
			const copied = toast.kind === 'ok' && !removed && toast.copied > 0;
			const text =
				toast.kind === 'ok'
					? t(copied ? 'toast.forkedCopied' : removed ? 'toast.removed' : 'toast.forked', {
							path: toast.path,
							...(copied ? { count: toast.copied } : {}),
						})
					: t(removed ? 'toast.removeFailed' : 'toast.forkFailed', { message: toast.message });
			return h(
				React.Fragment,
				null,
				h(Styles),
				h(
					'div',
					{ className: 'dshForkWtToast', role: 'status' },
					h('span', {
						className: `dshForkWtDot ${toast.kind === 'ok' ? 'dshForkWtDotOk' : 'dshForkWtDotError'}`,
					}),
					h('span', { className: 'dshForkWtToastText' }, text),
				),
			);
		}

		/** Client services this bundle registers through. */
		const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace'];

		/**
		 * Register the Workspace-row buttons, the dialog, and the toast.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			const request = observable(null);
			const toast = observable(null);
			let toastSeq = 0;
			const notify = (value) => {
				toastSeq += 1;
				toast.set({ ...value, seq: toastSeq });
			};
			const report = (action) => (error) => {
				notify({ kind: 'error', action, message: error instanceof Error ? error.message : String(error) });
			};

			/** The Workspace's directory, read from the Client's live projection. */
			const pathOf = (workspaceId) => {
				const items = ctx.workspaces.list.getSnapshot().items;
				return items.find((item) => item.workspaceId === workspaceId)?.path;
			};

			/** Post one route request and answer its structured outcome. */
			const post = async (route, body) => {
				const response = await fetch(route, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response.ok) return { failure: `HTTP ${response.status}` };
				return { outcome: await response.json() };
			};

			/**
			 * Create the worktree workspace for one Workspace row.
			 * @param options - `init` for the not-a-repository retry, and `copy` for
			 * the creation mode the mode step selected.
			 * @returns `'dialog'` when the caller must keep the dialog open in its
			 * initialize mode, `'settled'` when the outcome was reported.
			 */
			const fork = async (workspaceId, options) => {
				const source = pathOf(workspaceId);
				if (source === undefined) {
					notify({ kind: 'error', action: FORK, message: `unknown workspace ${workspaceId}` });
					return 'settled';
				}
				const copy = options.copy === true;
				const { outcome, failure } = await post(FORK_ROUTE, { source, init: options.init === true, mode: copy ? 'copy' : 'git' });
				if (failure !== undefined) {
					notify({ kind: 'error', action: FORK, message: failure });
					return 'settled';
				}
				if (outcome?.ok !== true) {
					if (outcome?.code === 'not-a-git-repo' && options.init !== true) {
						request.set({ workspaceId, source: outcome.path ?? source, mode: INITIALIZE, copy });
						return 'dialog';
					}
					notify({ kind: 'error', action: FORK, message: outcome?.message ?? 'the fork route reported no outcome' });
					return 'settled';
				}
				/* The Host already registered it; this adopts the same record locally. */
				const workspace = await ctx.workspaces.create({ path: outcome.path });
				ctx.uiWorkspace.startSession(workspace.workspaceId);
				notify({ kind: 'ok', action: FORK, path: outcome.path, copied: typeof outcome.copied === 'number' ? outcome.copied : 0 });
				return 'settled';
			};

			/**
			 * Delete the directory of one Workspace row and drop its registration.
			 * @returns `'dialog'` when the caller must keep the dialog open in its
			 * force mode, `'settled'` when the outcome was reported.
			 */
			const remove = async (workspaceId, options) => {
				const source = pathOf(workspaceId);
				if (source === undefined) {
					notify({ kind: 'error', action: REMOVE, message: `unknown workspace ${workspaceId}` });
					return 'settled';
				}
				const { outcome, failure } = await post(REMOVE_ROUTE, { source, force: options.force === true });
				if (failure !== undefined) {
					notify({ kind: 'error', action: REMOVE, message: failure });
					return 'settled';
				}
				if (outcome?.ok !== true) {
					if (outcome?.code === 'worktree-dirty' && options.force !== true) {
						request.set({ workspaceId, source: outcome.path ?? source, mode: REMOVE_FORCE });
						return 'dialog';
					}
					notify({ kind: 'error', action: REMOVE, message: outcome?.message ?? 'the remove route reported no outcome' });
					return 'settled';
				}
				notify({ kind: 'ok', action: REMOVE, path: outcome.path });
				return 'settled';
			};

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fork-worktree: dictionaries');

			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-rows',
						locale: NS,
						inject: () => ({
							/* A click asks; it never acts. */
							forkWorkspace: (workspaceId) => {
								const source = pathOf(workspaceId);
								if (source === undefined) {
									notify({ kind: 'error', action: FORK, message: `unknown workspace ${workspaceId}` });
									return;
								}
								request.set({ workspaceId, source, mode: CONFIRM, copy: false });
							},
							removeWorkspace: (workspaceId) => {
								const source = pathOf(workspaceId);
								if (source === undefined) {
									notify({ kind: 'error', action: REMOVE, message: `unknown workspace ${workspaceId}` });
									return;
								}
								request.set({ workspaceId, source, mode: REMOVE });
							},
						}),
					},
					WorkspaceRowActions,
				);
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-dialog',
						locale: NS,
						inject: () => ({
							hooks: { workspaceRequest: request },
							settleWorkspaceRequest: () => {
								request.set(null);
							},
							confirmWorkspaceRequest: async (workspaceId, step, copy) => {
								const removing = step === REMOVE || step === REMOVE_FORCE;
								const run = removing
									? () => remove(workspaceId, { force: step === REMOVE_FORCE })
									: () => fork(workspaceId, { init: step === INITIALIZE, copy: copy === true });
								const outcome = await run().catch((error) => {
									report(removing ? REMOVE : FORK)(error);
									return 'settled';
								});
								/* Only a refusal keeps the dialog: it reopens stronger. */
								if (outcome !== 'dialog') request.set(null);
							},
						}),
					},
					WorkspaceActionDialog,
				);
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-toast',
						locale: NS,
						inject: () => ({
							hooks: { workspaceToast: toast },
							dismissWorkspaceToast: () => {
								toast.set(null);
							},
						}),
					},
					WorkspaceActionToast,
				);
			});
		}

		return { inject, apply };
	},
});
