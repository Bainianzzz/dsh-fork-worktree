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
 * It covers the two-step fork flow: the confirmation step only opens the mode
 * question and posts nothing, the mode step defaults to the git mode, choosing
 * copy relabels the action and is sent as `mode: "copy"`, a non-repository
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

/* Case 1: the confirmation step asks, and never posts. */
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
let root = paint();
check('confirm step shows its title', textOf(root).includes('新建 worktree 工作区'));
check('confirm step offers cancel', buttons(root).map(textOf).includes('取消'));
check('confirm step offers create', buttons(root).map(textOf).includes('创建 worktree'));
check('confirm step shows no mode options', inputs(root).length === 0);

/* Case 2: create opens the mode step, still without posting. */
await click(root, '创建 worktree');
await settle();
check('the create button opens the mode step', state()?.mode === 'mode', JSON.stringify(state()));
check('the create button posts nothing', calls.length === 0);
root = paint();
check('mode step shows its title', textOf(root).includes('选择创建方式'));
check('mode step offers exactly two modes', inputs(root).length === 2, String(inputs(root).length));
check('mode step names both modes', textOf(root).includes('仅 git worktree') && textOf(root).includes('复制全部文件'));
check('mode step explains both modes', textOf(root).includes('.gitignore') && textOf(root).includes('node_modules'));
check('mode step has an exit button', buttons(root).map(textOf).includes('退出'));
check('mode step defaults to the git mode', inputs(root)[0].props.checked === true && inputs(root)[1].props.checked === false);
check('mode step primary creates a worktree', buttons(root).map(textOf).includes('创建 worktree'));

/* Case 3: choosing copy relabels the action. */
inputs(root)[1].props.onChange();
root = paint();
const checked = inputs(root).filter((node) => node.props.checked);
check('choosing copy checks its radio', checked.length === 1 && checked[0].props.name === 'dshForkWtMode-w1');
check('choosing copy relabels the action', buttons(root).map(textOf).includes('复制并创建'));

/* Case 4: the mode step posts the chosen mode, and a refusal keeps it. */
response = { ok: false, code: 'not-a-git-repo', message: 'not-a-git-repo: /tmp/repo', path: '/tmp/repo' };
await click(root, '复制并创建');
await settle();
check('the mode step posts once', calls.length === 1, JSON.stringify(calls));
check('the post carries the copy mode', calls[0]?.body.mode === 'copy', JSON.stringify(calls[0]?.body));
check('the post is not an init request', calls[0]?.body.init === false);
check('a non-repository reopens the initialize step', state()?.mode === 'initialize', JSON.stringify(state()));
check('the initialize step keeps the chosen mode', state()?.copy === true);
root = paint();
check('initialize step explains the copy', textOf(root).includes('初始化之后'));
check('initialize step offers its action', buttons(root).map(textOf).includes('初始化并创建 worktree'));

/* Case 5: success closes the dialog and reports the copied count. */
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

/* Case 6: the default mode posts git. */
calls.length = 0;
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
root = paint();
await click(root, '创建 worktree');
await settle();
root = paint();
check('the mode step defaults to the create action', buttons(root).map(textOf).includes('创建 worktree'));
response = { ok: true, path: '/tmp/repo-wt-def456', branch: 'wt/def456', mode: 'git', copied: 0, workspaceId: 'host-2' };
await click(root, '创建 worktree');
await settle();
check('the default mode posts git', calls.length === 1 && calls[0].body.mode === 'git', JSON.stringify(calls[0]?.body));
check('a git-mode fork toasts without a count', toastState()?.copied === 0);
check('a git-mode toast shows only the path', textOf(paintToast()).includes('已创建 worktree 工作区：/tmp/repo-wt-def456') && !textOf(paintToast()).includes('复制了'));

/* Case 7: cancel closes without posting. */
calls.length = 0;
requestStore.set({ workspaceId: 'w1', source: '/tmp/repo', mode: 'confirm', copy: false });
root = paint();
await click(root, '取消');
check('cancel closes the dialog', state() === null);
check('cancel posts nothing', calls.length === 0);

/* Case 8: the removal steps are unchanged. */
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
