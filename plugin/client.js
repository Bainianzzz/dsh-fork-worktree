/**
 * Client half of the `@local/dsh-fork-worktree` bundle.
 *
 * A fork button on every *Workspace* row of the sidebar's workspace browser,
 * one confirmation dialog, and one toast.
 *
 * The workspace row is not a slot host: DSH renders its "…" menu and its "+"
 * new-session button as private row chrome with no extension point, so this
 * bundle mounts the button into that row's action strip through a React portal
 * and re-scans on DOM mutations. The strip is the last element child of the row
 * carrying `data-row-key="workspace:<id>"`, and the button is inserted directly
 * before the "+" — the host hides the whole strip until the row is hovered, so
 * the button inherits that behavior.
 *
 * Nothing is created on a click: the button only opens the dialog. Confirming
 * posts the Workspace's directory to the Host route, which creates the worktree
 * and registers the Workspace, and this half then adopts that Workspace into the
 * Client model and opens a Session in it. A directory that is not a repository
 * answers with `not-a-git-repo`, and the same dialog reopens in its initialize
 * mode instead of reporting a failure.
 *
 * Controls are hand-written against theme tokens; the markup and CSS follow the
 * host's `iconButton`, `Modal`, and `Toast` and share only the `--dsw-*` tokens.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-fork-worktree',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		const createPortal = ReactDOM.createPortal ?? ReactDOM.default?.createPortal;

		/** Dictionary namespace owned by this plugin. */
		const NS = 'fork-worktree';

		/** Host route, relative so a mount prefix keeps working. */
		const ROUTE = 'dsh-fork-worktree/fork';

		/** Workspace rows carry this prefix in `data-row-key`. */
		const ROW_SELECTOR = '[data-row-key^="workspace:"]';

		/** The renderer's stable anchor for the sidebar's browsing region. */
		const OUTLET_SELECTOR = '[data-slot="sidebar.workspaces"]';

		/** Marks the container this bundle injects into one row's action strip. */
		const CONTAINER_ATTRIBUTE = 'data-dsh-fork-worktree';

		/** How long a toast stays before it dismisses itself, matching the host's banner. */
		const TOAST_HOLD_MS = 3200;

		/** Dialog modes: plain confirmation, and the retry that initializes first. */
		const CONFIRM = 'confirm';
		const INITIALIZE = 'initialize';

		const zh = {
			'action.fork': '用新 worktree 创建工作区',
			'action.forkFailed': '创建 worktree 失败：{message}',
			'action.forked': '已创建 worktree 工作区：{path}',
			'confirm.title': '新建 worktree 工作区',
			'confirm.desc': '将基于 {path} 所在的仓库创建一个新的 git worktree，并把该 worktree 注册为一个新的 dsh 工作区。',
			'confirm.action': '创建 worktree',
			'confirm.busy': '正在创建 worktree…',
			'init.title': '该目录不是 git 仓库',
			'init.desc': '无法为 {path} 创建 worktree。可以先用 git init 把它初始化为仓库（把该目录当前的内容提交为第一个提交），再创建 worktree。',
			'init.action': '初始化并创建 worktree',
			'init.busy': '正在初始化并创建 worktree…',
			'cancel': '取消',
		};
		const en = {
			'action.fork': 'Create a workspace on a new worktree',
			'action.forkFailed': 'Creating the worktree failed: {message}',
			'action.forked': 'Created a worktree workspace: {path}',
			'confirm.title': 'New worktree workspace',
			'confirm.desc': 'A new git worktree will be created from the repository that owns {path}, and that worktree will be registered as a new dsh workspace.',
			'confirm.action': 'Create worktree',
			'confirm.busy': 'Creating the worktree…',
			'init.title': 'This directory is not a git repository',
			'init.desc': "No worktree can be created for {path} yet. Initialize it as a repository first (git init, committing the directory's current content as its first commit), then create the worktree.",
			'init.action': 'Initialize and create worktree',
			'init.busy': 'Initializing and creating the worktree…',
			'cancel': 'Cancel',
		};

		const css = `
.dshForkWtContainer{display:inline-flex;align-items:center;flex:none}
.dshForkWtButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshForkWtButton:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshForkWtButton:disabled{opacity:.5;cursor:default}
.dshForkWtMask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dshForkWtMask::after{content:'';position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshForkWtDialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;width:min(420px,100%);max-height:100%;overflow:auto;padding:22px 24px 24px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.dshForkWtDialog:focus{outline:none}
.dshForkWtTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dshForkWtDesc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshForkWtPath{color:var(--dsw-alias-label-primary)}
.dshForkWtStatus{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshForkWtActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshForkWtAction{box-sizing:border-box;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dshForkWtAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshForkWtAction:disabled{cursor:not-allowed;opacity:.4}
.dshForkWtActionPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshForkWtActionPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
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

		/** Git-branch glyph, drawn inline: the bundle imports no host icon package. */
		function BranchIcon() {
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: 14,
					height: 14,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.4,
					strokeLinecap: 'round',
					'aria-hidden': true,
				},
				h('circle', { cx: 4, cy: 3.6, r: 1.6 }),
				h('circle', { cx: 12, cy: 3.6, r: 1.6 }),
				h('circle', { cx: 8, cy: 12.4, r: 1.6 }),
				h('path', { d: 'M4 5.2v1.6c0 1.2 1 2.2 2.2 2.2h3.6c1.2 0 2.2-1 2.2-2.2V5.2' }),
				h('path', { d: 'M8 9v1.8' }),
			);
		}

		/** One Workspace row's button, portalled into that row's action strip. */
		function WorkspaceForkButton({ workspaceId, forkWorkspace, t }) {
			const label = t('action.fork');
			return h('button', {
				type: 'button',
				className: 'dshForkWtButton',
				'aria-label': label,
				title: label,
				onClick: (event) => {
					event.stopPropagation();
					forkWorkspace(workspaceId);
				},
				children: h(BranchIcon),
			});
		}

		/**
		 * The `shell.overlay` entry that keeps one button mounted in every
		 * Workspace row.
		 *
		 * It watches the sidebar's own slot outlet (`data-slot`, the renderer's
		 * stable anchor) rather than the whole frame, so a streaming Conversation
		 * elsewhere in the frame costs no scans, and it re-uses the container it
		 * already injected, so a re-render of the row neither duplicates the button
		 * nor loses it.
		 */
		function WorkspaceForkHost({ forkWorkspace, t }) {
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
								h(WorkspaceForkButton, { workspaceId: target.workspaceId, forkWorkspace, t }),
								target.container,
								target.workspaceId,
							),
						),
			);
		}

		/** The one dialog: confirmation first, and initialization only after a refusal. */
		function ForkWorktreeDialog({ useForkWorktreeRequest, settleForkWorktree, confirmForkWorktree, t }) {
			const request = useForkWorktreeRequest((pending) => pending);
			if (request === null) return null;
			return h(ForkWorktreeDialogBody, {
				key: request.workspaceId,
				request,
				settle: settleForkWorktree,
				confirm: confirmForkWorktree,
				t,
			});
		}

		/** One pending request's dialog; its in-flight state dies with it. */
		function ForkWorktreeDialogBody({ request, settle, confirm, t }) {
			const [busy, setBusy] = React.useState(false);
			const primary = React.useRef(null);
			React.useEffect(() => {
				primary.current?.focus();
			}, []);
			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key === 'Escape' && !busy) settle();
				};
				window.addEventListener('keydown', onKeyDown);
				return () => window.removeEventListener('keydown', onKeyDown);
			}, [busy, settle]);
			const initialize = request.mode === INITIALIZE;
			const prefix = initialize ? 'init' : 'confirm';
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
					busy ? h('p', { className: 'dshForkWtStatus', role: 'status' }, t(`${prefix}.busy`)) : null,
					h(
						'div',
						{ className: 'dshForkWtActions' },
						h(
							'button',
							{
								type: 'button',
								className: 'dshForkWtAction',
								disabled: busy,
								onClick: () => {
									if (!busy) settle();
								},
							},
							t('cancel'),
						),
						h(
							'button',
							{
								type: 'button',
								ref: primary,
								className: 'dshForkWtAction dshForkWtActionPrimary',
								disabled: busy,
								onClick: () => {
									setBusy(true);
									Promise.resolve(confirm(request.workspaceId, request.mode)).finally(() => setBusy(false));
								},
							},
							t(`${prefix}.action`),
						),
					),
				),
			);
		}

		/** The outcome banner for one finished attempt. */
		function ForkWorktreeToast({ useForkWorktreeToast, dismissForkWorktreeToast, t }) {
			const toast = useForkWorktreeToast((pending) => pending);
			React.useEffect(() => {
				if (toast === null) return undefined;
				const timer = setTimeout(dismissForkWorktreeToast, TOAST_HOLD_MS);
				return () => clearTimeout(timer);
			}, [toast === null ? 0 : toast.seq]);
			if (toast === null) return null;
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
					h(
						'span',
						{ className: 'dshForkWtToastText' },
						toast.kind === 'ok'
							? t('action.forked', { path: toast.path })
							: t('action.forkFailed', { message: toast.message }),
					),
				),
			);
		}

		/** Client services this bundle registers through. */
		const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace'];

		/**
		 * Register the Workspace-row button, the dialog, and the toast.
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
			const report = (error) => {
				notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
			};

			/** The Workspace's directory, read from the Client's live projection. */
			const pathOf = (workspaceId) => {
				const items = ctx.workspaces.list.getSnapshot().items;
				return items.find((item) => item.workspaceId === workspaceId)?.path;
			};

			/**
			 * Post one fork request and act on its structured outcome.
			 * @returns `'dialog'` when the caller must keep the dialog open in its
			 * initialize mode, `'settled'` when the outcome was reported and the
			 * dialog may close.
			 */
			const fork = async (workspaceId, options) => {
				const source = pathOf(workspaceId);
				if (source === undefined) {
					notify({ kind: 'error', message: `unknown workspace ${workspaceId}` });
					return 'settled';
				}
				let response;
				try {
					response = await fetch(ROUTE, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ source, init: options.init === true }),
					});
				} catch (error) {
					report(error);
					return 'settled';
				}
				if (!response.ok) {
					notify({ kind: 'error', message: `fork route failed: HTTP ${response.status}` });
					return 'settled';
				}
				let outcome;
				try {
					outcome = await response.json();
				} catch (error) {
					report(error);
					return 'settled';
				}
				if (outcome?.ok !== true) {
					if (outcome?.code === 'not-a-git-repo' && options.init !== true) {
						request.set({ workspaceId, source: outcome.path ?? source, mode: INITIALIZE });
						return 'dialog';
					}
					notify({ kind: 'error', message: outcome?.message ?? 'the fork route reported no outcome' });
					return 'settled';
				}
				/* The Host already registered it; this adopts the same record locally. */
				const workspace = await ctx.workspaces.create({ path: outcome.path });
				ctx.uiWorkspace.startSession(workspace.workspaceId);
				notify({ kind: 'ok', path: outcome.path });
				return 'settled';
			};

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fork-worktree: dictionaries');

			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-workspaces',
						locale: NS,
						inject: () => ({
							/* A click asks; it never creates. */
							forkWorkspace: (workspaceId) => {
								const source = pathOf(workspaceId);
								if (source === undefined) {
									notify({ kind: 'error', message: `unknown workspace ${workspaceId}` });
									return;
								}
								request.set({ workspaceId, source, mode: CONFIRM });
							},
						}),
					},
					WorkspaceForkHost,
				);
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-dialog',
						locale: NS,
						inject: () => ({
							hooks: { forkWorktreeRequest: request },
							settleForkWorktree: () => {
								request.set(null);
							},
							confirmForkWorktree: async (workspaceId, mode) => {
								const outcome = await fork(workspaceId, { init: mode === INITIALIZE }).catch((error) => {
									report(error);
									return 'settled';
								});
								/* Only a refusal keeps the dialog: it reopens initialized. */
								if (outcome !== 'dialog') request.set(null);
							},
						}),
					},
					ForkWorktreeDialog,
				);
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'fork-worktree-toast',
						locale: NS,
						inject: () => ({
							hooks: { forkWorktreeToast: toast },
							dismissForkWorktreeToast: () => {
								toast.set(null);
							},
						}),
					},
					ForkWorktreeToast,
				);
			});
		}

		return { inject, apply };
	},
});
