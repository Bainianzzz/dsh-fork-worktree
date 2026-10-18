/**
 * Standalone smoke test for the fork-worktree Client half, run outside dsh.
 *
 * `client.js` is a `window.__ModuleLoader__` bundle whose only imports are
 * React and ReactDOM, so this script supplies a minimal React runtime (element
 * creation, `useState`, `useRef`, `useEffect`, `Fragment`), a fake module
 * loader, a fake Client context, and a fake `fetch`. The components under test
 * are the real ones: `apply` registers them, this harness paints them and
 * invokes the handlers a click would.
 *
 * It covers the single-panel fork flow: one dialog explains both modes and
 * offers one button per mode, each button posts its own `mode`, a non-repository
 * refusal reopens the initialize step with the chosen mode kept, success closes
 * the dialog and toasts the copied count, and the removal steps are unchanged.
 *
 * Run with `node verify-client.mjs`. No dependency, no browser, no dsh.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/* ---- minimal React ---- */
const stores = new Map();
let currentStore = null;

function createElement(type, props, ...children) {
	const merged = { ...(props ?? {}) };
	if (children.length === 1) merged.children = children[0];
	else if (children.length > 1) merged.children = children;
	return { type, props: merged };
}

function storeFor(type) {
	let store = stores.get(type);
	if (store === undefined) {
		store = { index: 0, states: [], refs: [] };
		stores.set(type, store);
	}
	return store;
}

function useState(initial) {
	const store = currentStore;
	const index = store.index;
	store.index += 1;
	if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial;
	return [
		store.states[index],
		(next) => {
			store.states[index] = typeof next === 'function' ? next(store.states[index]) : next;
		},
	];
}

function useRef(initial) {
	const store = currentStore;
	const index = store.index;
	store.index += 1;
	if (!(index in store.refs)) store.refs[index] = { current: initial };
	return store.refs[index];
}

/** Effects only focus and timer wiring; the harness drives state itself. */
function useEffect() {}

function Fragment(props) {
	return props.children;
}

const React = { createElement, useState, useRef, useEffect, Fragment };
const ReactDOM = {};

/** Expand one element tree into plain `{ type, props, children }` nodes. */
function renderNode(node) {
	if (node === null || node === undefined || node === false || node === true) return null;
	if (Array.isArray(node)) {
		return node.flatMap((child) => {
			const out = renderNode(child);
			return out === null ? [] : [out];
		});
	}
	if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node) };
	if (typeof node.type === 'function') {
		const store = storeFor(node.type);
		store.index = 0;
		const previous = currentStore;
		currentStore = store;
		let out;
		try {
			out = node.type(node.props ?? {});
		} finally {
			currentStore = previous;
		}
		return renderNode(out);
	}
	const rendered = renderNode(node.props?.children);
	return {
		type: node.type,
		props: node.props ?? {},
		children: rendered === null ? [] : Array.isArray(rendered) ? rendered : [rendered],
	};
}

function textOf(node) {
	if (node === null || node === undefined) return '';
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (node.type === '#text') return node.text;
	if (node.type === 'style') return '';
	return (node.children ?? []).map(textOf).join('');
}

function findAll(node, predicate, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, predicate, out);
		return out;
	}
	if (node.type !== '#text' && predicate(node)) out.push(node);
	for (const child of node.children ?? []) findAll(child, predicate, out);
	return out;
}

const buttons = (root) => findAll(root, (node) => node.type === 'button');
const inputs = (root) => findAll(root, (node) => node.type === 'input');

/* ---- load the bundle ---- */
let factory;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			factory = definition.factory;
		},
	},
};
await import(`file://${join(here, 'client.js')}?smoke=${Date.now()}`);
if (factory === undefined) throw new Error('the bundle did not call window.__ModuleLoader__.load');

/* ---- fake Client context ---- */
let dictionaries;
const registrations = new Map();
const sessions = [];
const workspaces = {
	rows: [],
	async create({ path }) {
		const row = { workspaceId: `w${this.rows.length + 1}`, path };
		this.rows.push(row);
		return row;
	},
	list: { getSnapshot: () => ({ items: workspaces.rows }) },
};

const context = {
	effect: (fn) => {
		fn();
	},
	locale: {
		register: (_namespace, dicts) => {
			dictionaries = dicts;
		},
	},
	workspaces,
	uiWorkspace: {
		startSession: (id) => sessions.push(id),
	},
	slots: {
		inject: (_name, generator) => {
			for (const _ of generator());
		},
		register: (meta, component) => {
			registrations.set(meta.id, { meta, component });
			return () => {};
		},
	},
};

const modules = { react: React, 'react-dom': ReactDOM };
factory((name) => {
	if (!(name in modules)) throw new Error(`unexpected require: ${name}`);
	return modules[name];
}).apply(context);

/* ---- locale ---- */
function t(key, variables = {}) {
	const template = dictionaries.zh[key];
	if (template === undefined) throw new Error(`missing zh dictionary key: ${key}`);
	return template.replace(/\{(\w+)\}/gu, (_match, name) => (name in variables ? String(variables[name]) : `{${name}}`));
}

/* ---- request store, fetch stub, paint helpers ---- */
const calls = [];
let response;
globalThis.fetch = async (route, init) => {
	calls.push({ route, body: JSON.parse(init.body) });
	return { ok: true, json: async () => response };
};

const checks = [];
const check = (label, condition, detail = '') => {
	checks.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
	if (!condition) process.exitCode = 1;
};

const dialogEntry = registrations.get('fork-worktree-dialog');
const toastEntry = registrations.get('fork-worktree-toast');
const dialogInfo = dialogEntry.meta.inject();
const toastInfo = toastEntry.meta.inject();

const requestStore = dialogInfo.hooks.workspaceRequest;
const toastStore = toastInfo.hooks.workspaceToast;
const state = () => requestStore.getSnapshot();
const toastState = () => toastStore.getSnapshot();
/* Closing the dialog unmounts its body; react does that, the harness clears the hook stores. */
requestStore.subscribe(() => {
	if (requestStore.getSnapshot() === null) stores.clear();
});

const paint = () =>
	renderNode(
		React.createElement(dialogEntry.component, {
			...dialogInfo,
			t,
			useWorkspaceRequest: (selector) => selector(requestStore.getSnapshot()),
		}),
	);
const paintToast = () =>
	renderNode(
		React.createElement(toastEntry.component, {
			...toastInfo,
			t,
			useWorkspaceToast: (selector) => selector(toastStore.getSnapshot()),
		}),
	);

const click = async (root, label) => {
	const button = buttons(root).find((node) => textOf(node) === label);
	if (button === undefined) throw new Error(`no button labelled ${label}; saw ${buttons(root).map(textOf).join(' | ')}`);
	await button.props.onClick();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* The workspace row the user clicked is part of the Client projection. */
workspaces.rows.push({ workspaceId: 'w1', path: '/tmp/repo' });

/* Case 1: one dialog states both modes and offers one button each. */
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
let root = paint();
check('confirm step shows its title', textOf(root).includes('新建 worktree 工作区'));
check('confirm step names the path', textOf(root).includes('/tmp/repo'));
check('confirm step explains both modes', textOf(root).includes('仅 git worktree') && textOf(root).includes('复制全部文件'));
check('confirm step details both modes', textOf(root).includes('.gitignore') && textOf(root).includes('额外复制未跟踪文件'));
check('confirm step has three buttons in order', JSON.stringify(buttons(root).map(textOf)) === JSON.stringify(['取消', '创建 git worktree', '复制并创建 worktree']), JSON.stringify(buttons(root).map(textOf)));
check('confirm step has no mode radios', inputs(root).length === 0);
const creationButtons = buttons(root).filter((node) => ['取消', '创建 git worktree', '复制并创建 worktree'].includes(textOf(node)));
check('cancel is the ghost action', creationButtons[0]?.props.className.includes('dshForkWtActionGhost') === true, creationButtons[0]?.props.className);
check('the git action is the primary', creationButtons[1]?.props.className.includes('dshForkWtActionPrimary') === true, creationButtons[1]?.props.className);
check('the copy action is the outlined action', creationButtons[2]?.props.className === 'dshForkWtAction', creationButtons[2]?.props.className);
check('opening the dialog posts nothing', calls.length === 0);

/* Case 2: the git button posts the git mode, and a refusal keeps it. */
response = { ok: false, code: 'not-a-git-repo', message: 'not-a-git-repo: /tmp/repo', path: '/tmp/repo' };
await click(root, '创建 git worktree');
await settle();
check('the git button posts once', calls.length === 1, JSON.stringify(calls));
check('the git button posts the git mode', calls[0]?.body.mode === 'git', JSON.stringify(calls[0]?.body));
check('the git button is not an init request', calls[0]?.body.init === false);
check('a non-repository reopens the initialize step', state()?.mode === 'initialize', JSON.stringify(state()));
check('the initialize step keeps the git mode', state()?.copy === false);
root = paint();
check('initialize step hides the copy hint', !textOf(root).includes('初始化之后'));
check('initialize step offers its action', buttons(root).map(textOf).includes('初始化并创建 worktree'));
check('initialize step drops the creation choice', buttons(root).length === 2, String(buttons(root).length));

/* Case 3: the copy button posts the copy mode, and the retry keeps it. */
calls.length = 0;
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
root = paint();
await click(root, '复制并创建 worktree');
await settle();
check('the copy button posts the copy mode', calls.length === 1 && calls[0].body.mode === 'copy', JSON.stringify(calls[0]?.body));
check('the copy button is not an init request', calls[0]?.body.init === false);
check('the copy refusal keeps the copy mode', state()?.copy === true);
root = paint();
check('initialize step explains the copy', textOf(root).includes('初始化之后'));
response = { ok: true, path: '/tmp/repo-wt-abc123', branch: 'wt/abc123', mode: 'copy', copied: 7, workspaceId: 'host-1' };
await click(root, '初始化并创建 worktree');
await settle();
check('the initialize step posts an init request', calls.length === 2 && calls[1].body.init === true, JSON.stringify(calls[1]?.body));
check('the init post keeps the copy mode', calls[1]?.body.mode === 'copy');
check('success closes the dialog', state() === null);
check('success adopts the workspace', workspaces.rows.length === 2 && workspaces.rows[1].path === '/tmp/repo-wt-abc123', JSON.stringify(workspaces.rows));
check('success opens a session', sessions.length === 1 && sessions[0] === 'w2', JSON.stringify(sessions));
check('success toasts the path', toastState()?.kind === 'ok' && toastState()?.path === '/tmp/repo-wt-abc123', JSON.stringify(toastState()));
check('success toasts the copied count', toastState()?.copied === 7, String(toastState()?.copied));
check('the toast names the copied count', textOf(paintToast()).includes('复制了 7 项'), textOf(paintToast()));

/* Case 4: the git button creates without copying. */
calls.length = 0;
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
root = paint();
response = { ok: true, path: '/tmp/repo-wt-def456', branch: 'wt/def456', mode: 'git', copied: 0, workspaceId: 'host-2' };
await click(root, '创建 git worktree');
await settle();
check('the git button creates without copying', calls.length === 1 && calls[0].body.mode === 'git', JSON.stringify(calls[0]?.body));
check('a git-mode fork toasts without a count', toastState()?.copied === 0);
check('a git-mode toast shows only the path', textOf(paintToast()).includes('已创建 worktree 工作区：/tmp/repo-wt-def456') && !textOf(paintToast()).includes('复制了'));

/* Case 5: cancel closes without posting. */
calls.length = 0;
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
root = paint();
await click(root, '取消');
check('cancel closes the dialog', state() === null);
check('cancel posts nothing', calls.length === 0);

/* Case 6: the removal steps are unchanged. */
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'remove', copy: false });
root = paint();
check('remove step names the path', textOf(root).includes('/tmp/repo'));
check('remove step asks for deletion', buttons(root).map(textOf).includes('删除文件夹'));
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'remove-force', copy: false });
root = paint();
const danger = buttons(root).find((node) => textOf(node) === '强制删除');
check('force step is destructive styling', danger?.props.className.includes('dshForkWtActionDanger') === true, danger?.props.className);
check('force step says why', textOf(root).includes('未提交的修改或未跟踪文件'));

console.log(checks.join('\n'));
const failed = checks.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
