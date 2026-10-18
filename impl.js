/**
 * Host half of the `@bainianzzz/dsh-fork-worktree` bundle.
 *
 * One operation, three entry points that all call {@link createWorktreeFork}:
 * the Client button POSTs to the fork route below, and a human can type the
 * `/fork-worktree` command. The operation resolves a workspace directory,
 * creates a git worktree of the repository that owns it, and registers the
 * worktree as a durable DSH Workspace.
 *
 * The worktree starts as `git worktree add` leaves it — HEAD only — so a
 * request can also select the copy mode, which then fills in every path the
 * checkout is missing from the directory it was made from: untracked files and
 * `.gitignore`d content such as `node_modules` or `.env`. Tracked files keep
 * their HEAD version, so the new worktree never starts with someone's
 * uncommitted edits.
 *
 * A second route, {@link removeWorkspaceFolder}, does the inverse for the
 * Client's trash button: it deletes a Workspace's directory (through
 * `git worktree remove` when the directory is a linked worktree, so the
 * repository's own metadata goes with it) and drops the registration. There is
 * deliberately no command for it — a command would default to the calling
 * Session's own workspace, and deleting the directory a user is working in must
 * not be one keystroke away.
 *
 * The bundle also keeps Workspace rows honest: `git worktree remove` (or a
 * merge flow that deletes the checkout) makes a fork's directory disappear, and
 * a sweep then removes that Workspace registration instead of leaving a broken
 * row behind. A directory that exists and carries a `.git` file is a linked
 * worktree, which is what the sweep tracks; a missing directory is accepted as
 * a removed fork when the name says so (a generated label, or an explicit label
 * beside its repository), so a restart does not strand the row either.
 *
 * @module @bainianzzz/dsh-fork-worktree
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, rmSync, statSync } from 'node:fs';
import { cp, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

/** Plugin display name for the Loader row. */
export const name = 'fork-worktree';

/** Host capabilities this bundle registers through. */
export const inject = ['commands', 'connection', 'webServer', 'workspaceRegistry'];

/** Command name without its slash. */
const COMMAND = 'fork-worktree';

/** First-line marker the command answers a non-repository directory with. */
export const NOT_A_REPO = 'not-a-git-repo:';

/** Browser route the Client button posts to. */
const ROUTE_PATH = '/dsh-fork-worktree/fork';

/** Browser route the Client's trash button posts to. */
const REMOVE_ROUTE_PATH = '/dsh-fork-worktree/remove';

/** How often the sweep looks for removed worktrees. */
const WATCH_INTERVAL_MS = 2000;

/** Route request bodies are two short fields; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/** The infix between a repository name and a fork label. */
const FORK_INFIX = '-wt-';

/** Creation modes: the checkout git produces, or that checkout plus what it is missing. */
export const MODE_GIT = 'git';
export const MODE_COPY = 'copy';

/** A generated label: six lowercase hex characters. */
const GENERATED_LABEL = /^[0-9a-f]{6}$/u;

const USAGE = `Usage: /${COMMAND} [<name>] [--init] [--copy]`;

const execFileAsync = promisify(execFile);

/** Failure text for one rejected git invocation, preferring git's own stderr. */
function gitFailureMessage(error) {
	if (error !== null && typeof error === 'object' && typeof error.stderr === 'string' && error.stderr.trim() !== '') return error.stderr.trim();
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run one git invocation in a fixed working directory.
 *
 * No cancellation signal is threaded through: every invocation here mutates or
 * inspects this repository in well under a second, and abandoning a half-done
 * `git worktree add` would leave a registered worktree with no checkout.
 *
 * @param args - git arguments, without the executable.
 * @param cwd - working directory the invocation resolves paths against.
 * @returns the trimmed stdout, or the failure message.
 */
async function git(args, cwd) {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd,
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true,
		});
		return { ok: true, stdout: String(stdout).trim() };
	} catch (error) {
		return { ok: false, message: gitFailureMessage(error) };
	}
}

/** The repository root that owns `source`, or undefined when there is none. */
async function existingRepositoryRoot(source) {
	const result = await git(['rev-parse', '--show-toplevel'], source);
	/* git rev-parse exits non-zero outside a work tree; an empty stdout is the same answer. */
	if (!result.ok || result.stdout === '') return undefined;
	return result.stdout;
}

/**
 * Make the directory a repository when it is not one yet.
 *
 * `git worktree add` needs a commit to start from, so initialization commits the
 * directory's current content as the first commit (an empty commit when there is
 * nothing to add). That is what makes the worktree a copy of what the directory
 * holds now instead of an empty checkout.
 *
 * @param source - existing directory to inspect, and possibly to initialize.
 * @param allowInit - whether initialization is permitted at all.
 * @returns the repository root, or the refusal.
 */
async function repositoryRoot(source, allowInit) {
	const existing = await existingRepositoryRoot(source);
	if (existing !== undefined) return { ok: true, root: existing, initialized: false };
	if (!allowInit) return { ok: false, notARepository: true };
	const initialized = await git(['init'], source);
	if (!initialized.ok) return { ok: false, message: `git init failed: ${initialized.message}` };
	const identity = ['-c', 'user.name=DSH', '-c', 'user.email=dsh@localhost', '-c', 'commit.gpgsign=false'];
	/* A failed `add` only decides whether the commit below is empty. */
	await git(['add', '--all'], source);
	const message = 'Initialize repository for worktree forks';
	const committed = await git([...identity, 'commit', '-m', message], source);
	if (!committed.ok) {
		const empty = await git([...identity, 'commit', '--allow-empty', '-m', message], source);
		if (!empty.ok) return { ok: false, message: `git commit failed: ${empty.message}` };
	}
	const root = await existingRepositoryRoot(source);
	if (root === undefined) return { ok: false, message: 'git init produced no repository' };
	return { ok: true, root, initialized: true };
}

/** A path- and branch-safe label derived from a caller-supplied name. */
function sanitizeLabel(raw) {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');
	return cleaned === '' || cleaned === '.' ? undefined : cleaned;
}

/** Six lowercase hex characters, unique enough for one sibling directory. */
function shortId() {
	return randomUUID().replace(/-/gu, '').slice(0, 6);
}

/** Effective Session working directory, or undefined when the Session records none. */
function sessionCwd(agent) {
	const cwd = agent?.session?.header?.cwd;
	return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/** Whether a path is a byte-for-byte reproducible kind: a file, a directory, or a link. */
function isCopyable(path) {
	try {
		const info = lstatSync(path);
		return info.isFile() || info.isDirectory() || info.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Copy every path `target` is missing from `root`, the checkout it was made from.
 *
 * `git worktree add` writes the committed tree and nothing else, so forking a
 * working directory that carries dependencies and local configuration leaves a
 * checkout nobody can build in. This walks the source's top level and copies
 * only paths that are absent: an existing path is one git already placed, and it
 * keeps its HEAD version — which leaves exactly the untracked and ignored
 * content. The source's own `.git` never travels; it is the other checkout's
 * metadata.
 *
 * Node's `cp` merges into an existing directory and, with `force: false` and
 * `errorOnExist: false`, leaves existing files alone instead of failing, so one
 * call per top-level entry is enough. `preserveTimestamps` keeps mtime-reading
 * build caches (tsbuildinfo, bundler caches) from treating every copied file as
 * rebuilt. `verbatimSymlinks` is load-bearing: without it `cp` rewrites every
 * relative link to the absolute path it resolved to, so a pnpm-style
 * `node_modules/foo -> ../packages/foo` would point back at the source checkout
 * instead of the new worktree's own package.
 *
 * @param root - the checkout the worktree was created from.
 * @param target - the new worktree.
 * @returns how many paths were copied.
 */
async function copyMissingFrom(root, target) {
	let copied = 0;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === '.git') continue;
		await cp(join(root, entry.name), join(target, entry.name), {
			recursive: entry.isDirectory(),
			force: false,
			errorOnExist: false,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			/* Existing paths belong to git; only missing ones are counted or inspected. */
			filter: (from, to) => {
				if (existsSync(to)) return true;
				if (!isCopyable(from)) return false;
				copied += 1;
				return true;
			},
		});
	}
	return copied;
}

/**
 * Create one worktree of `source`'s repository and register it as a Workspace.
 *
 * @param ctx - Host context owning the Workspace registry.
 * @param request - source directory, optional label, whether to initialize, and
 * the creation mode: `git` (checkout only) or `copy` (checkout plus every path
 * the source has and the checkout does not).
 * @returns an outcome carrying either the new path and Workspace, or a stable code.
 */
export async function createWorktreeFork(ctx, request) {
	const source = request.source;
	if (typeof source !== 'string' || source === '') return { kind: 'error', code: 'no-source', text: 'no workspace directory was given' };
	if (!existsSync(source)) return { kind: 'error', code: 'source-missing', text: `workspace directory does not exist: ${source}` };
	if (!statSync(source).isDirectory()) return { kind: 'error', code: 'source-not-directory', text: `workspace path is not a directory: ${source}` };
	const mode = request.mode === MODE_COPY ? MODE_COPY : MODE_GIT;

	const repository = await repositoryRoot(source, request.init === true);
	if (!repository.ok) {
		if (repository.notARepository === true) return { kind: 'error', code: 'not-a-git-repo', path: source, text: `${NOT_A_REPO} ${source}` };
		return { kind: 'error', code: 'git-failed', text: repository.message };
	}

	const root = repository.root;
	const label = (request.name === undefined ? undefined : sanitizeLabel(request.name)) ?? shortId();
	const target = join(dirname(root), `${basename(root)}${FORK_INFIX}${label}`);
	const branch = `wt/${label}`;
	if (existsSync(target)) return { kind: 'error', code: 'target-exists', text: `worktree target already exists: ${target}` };

	const added = await git(['worktree', 'add', '-b', branch, target, 'HEAD'], source);
	if (!added.ok) return { kind: 'error', code: 'git-failed', text: `git worktree add failed: ${added.message}` };

	let copied = 0;
	if (mode === MODE_COPY) {
		try {
			copied = await copyMissingFrom(root, target);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			/* The copy runs before registration, so a failure must not strand a worktree nobody owns. */
			const cleaned = await git(['worktree', 'remove', '--force', target], root);
			if (!cleaned.ok) {
				return {
					kind: 'error',
					code: 'copy-failed',
					path: target,
					branch,
					text: `worktree created at ${target}, but copying the source content failed (${detail}) and the partial worktree could not be removed: ${cleaned.message}`,
				};
			}
			await git(['branch', '--delete', '--force', branch], root);
			return { kind: 'error', code: 'copy-failed', text: `copying the source content failed, so the worktree was removed: ${detail}` };
		}
	}

	let workspace;
	try {
		workspace = await ctx.workspaceRegistry.create(target);
	} catch (error) {
		/* The checkout exists; report where it is instead of hiding it behind the failure. */
		return {
			kind: 'error',
			code: 'register-failed',
			text: `worktree created at ${target}, but workspace registration failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	return {
		kind: 'success',
		path: target,
		branch,
		mode,
		copied,
		workspaceId: workspace.id,
		text: [
			target,
			'',
			`branch: ${branch}`,
			`source: ${root}`,
			`repository: ${repository.initialized ? 'initialized' : 'existing'}`,
			`mode: ${mode === MODE_COPY ? `git worktree plus ${String(copied)} copied paths` : 'git worktree only'}`,
			`workspace: ${workspace.path}`,
		].join('\n'),
	};
}

/** The registered Workspace owning exactly this directory, or undefined. */
function workspaceOwning(ctx, path) {
	for (const workspace of ctx.workspaceRegistry.list()) if (workspace.path === path) return workspace;
	return undefined;
}

/** Drop one Workspace registration, tolerating one that is already gone. */
async function unregisterWorkspace(ctx, workspace) {
	if (workspace === undefined) return;
	try {
		await ctx.workspaceRegistry.delete(workspace.id);
	} catch {
		/* the removal sweep covers a registration this call could not commit */
	}
}

/**
 * The main worktree that owns a linked worktree, or undefined when its
 * repository cannot be reached (a deleted main checkout, for example).
 */
async function mainWorktreeOf(dir) {
	const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
	if (!common.ok || common.stdout === '') return undefined;
	const root = dirname(common.stdout);
	return existsSync(root) ? root : undefined;
}

/**
 * Delete one Workspace's directory and drop its registration.
 *
 * A linked worktree goes through `git worktree remove`, so the repository's own
 * `worktrees/` metadata leaves with the checkout; any other directory is
 * removed as a directory. A worktree with uncommitted or untracked content is
 * refused unless `force` is set, which is what makes the Client able to ask a
 * second question before discarding work.
 *
 * @param ctx - Host context owning the Workspace registry.
 * @param request - directory to delete and whether dirty content may go with it.
 * @returns an outcome carrying the path and the method used, or a stable code.
 */
export async function removeWorkspaceFolder(ctx, request) {
	const source = request.source;
	if (typeof source !== 'string' || source === '') return { kind: 'error', code: 'no-source', text: 'no workspace directory was given' };
	if (!existsSync(source)) return { kind: 'error', code: 'source-missing', text: `workspace directory does not exist: ${source}` };
	if (!statSync(source).isDirectory()) return { kind: 'error', code: 'source-not-directory', text: `workspace path is not a directory: ${source}` };
	if (source === homedir() || dirname(source) === source) return { kind: 'error', code: 'refused-path', text: `refusing to delete ${source}` };

	const workspace = workspaceOwning(ctx, source);
	if (isLinkedWorktree(source)) {
		const root = await mainWorktreeOf(source);
		if (root !== undefined) {
			if (request.force !== true) {
				const status = await git(['status', '--porcelain'], source);
				if (status.ok && status.stdout !== '') {
					return { kind: 'error', code: 'worktree-dirty', path: source, text: `${source} contains modified or untracked files` };
				}
			}
			const removed = await git(['worktree', 'remove', ...(request.force === true ? ['--force'] : []), source], root);
			if (!removed.ok) return { kind: 'error', code: 'worktree-remove-failed', path: source, text: removed.message };
			await unregisterWorkspace(ctx, workspace);
			return { kind: 'success', path: source, method: 'worktree-remove', text: `removed worktree ${source}` };
		}
	}

	try {
		rmSync(source, { recursive: true, force: true });
	} catch (error) {
		return { kind: 'error', code: 'remove-failed', path: source, text: error instanceof Error ? error.message : String(error) };
	}
	await unregisterWorkspace(ctx, workspace);
	return { kind: 'success', path: source, method: 'removed-directory', text: `removed directory ${source}` };
}

/** Parse `[<name>] [--init] [--copy]`, rejecting anything else loudly enough to correct. */
function parseArguments(rawInput) {
	let name;
	let init = false;
	let mode = MODE_GIT;
	for (const token of rawInput.trim().split(/\s+/u).filter((part) => part !== '')) {
		if (token === '--init') {
			init = true;
			continue;
		}
		if (token === '--copy') {
			mode = MODE_COPY;
			continue;
		}
		if (token.startsWith('-')) return { error: `unknown option "${token}".\n${USAGE}` };
		if (name !== undefined) return { error: `at most one name is accepted.\n${USAGE}` };
		name = token;
	}
	return { name, init, mode };
}

/** Whether `dir` is the checkout of a linked worktree rather than a repository root. */
function isLinkedWorktree(dir) {
	try {
		return statSync(join(dir, '.git')).isFile();
	} catch {
		return false;
	}
}

/** Split `<repository>-wt-<label>` into its halves, or undefined for any other name. */
function forkLabelOf(path) {
	const name = basename(path);
	const at = name.lastIndexOf(FORK_INFIX);
	if (at <= 0) return undefined;
	const label = name.slice(at + FORK_INFIX.length);
	if (label === '') return undefined;
	return { repository: name.slice(0, at), label };
}

/**
 * Whether a *missing* directory was a fork this bundle could have made: its
 * generated label, or an explicit label adopted beside the repository it names.
 */
function looksLikeForkPath(path) {
	const parts = forkLabelOf(path);
	if (parts === undefined) return false;
	if (GENERATED_LABEL.test(parts.label)) return true;
	return existsSync(join(dirname(path), parts.repository));
}

/**
 * Remove the Workspace registration of a fork whose checkout is gone.
 *
 * A directory that exists and carries a `.git` file is a linked worktree, and
 * that is what this sweep tracks; once tracked, two consecutive sweeps must find
 * the directory missing before the registration goes, so a path that is briefly
 * unreadable (a sleeping volume, a running `git worktree move`) cannot cost the
 * user a Workspace. A directory that was never seen in this process is still
 * accepted when the name says it was a fork — see
 * {@link looksLikeForkPath} — so a restart does not strand the row either.
 * Nothing is reported when it works, and nothing is reported when the
 * registration was already gone.
 *
 * Exported for the standalone verification in `verify-host.mjs`.
 *
 * @param ctx - Host context owning the Workspace registry.
 * @param intervalMs - sweep period; the default is the shipped one.
 * @returns the sweep's disposer.
 */
export function watchRemovedWorktrees(ctx, intervalMs = WATCH_INTERVAL_MS) {
	const tracked = new Set();
	const missing = new Map();
	const sweep = async () => {
		let workspaces;
		try {
			workspaces = ctx.workspaceRegistry.list();
		} catch {
			return;
		}
		const live = new Set();
		for (const workspace of workspaces) {
			live.add(workspace.id);
			if (existsSync(workspace.path)) {
				missing.delete(workspace.id);
				if (isLinkedWorktree(workspace.path)) tracked.add(workspace.id);
				else tracked.delete(workspace.id);
				continue;
			}
			if (!tracked.has(workspace.id) && !looksLikeForkPath(workspace.path)) continue;
			const strikes = (missing.get(workspace.id) ?? 0) + 1;
			missing.set(workspace.id, strikes);
			if (strikes < 2) continue;
			missing.delete(workspace.id);
			tracked.delete(workspace.id);
			try {
				await ctx.workspaceRegistry.delete(workspace.id);
			} catch {
				/* an already-absent registration is the outcome we wanted */
			}
		}
		for (const id of [...tracked]) if (!live.has(id)) tracked.delete(id);
		for (const id of [...missing.keys()]) if (!live.has(id)) missing.delete(id);
	};
	const timer = setInterval(() => {
		sweep().catch(() => {});
	}, intervalMs);
	sweep().catch(() => {});
	return () => clearInterval(timer);
}

/** Bounded JSON response. */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			req.resume();
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * The envelope every route of this bundle shares: the connection's trust fence,
 * `POST` with a JSON object body, and a bounded JSON answer. The handler decides
 * only the status and body of an admitted request.
 *
 * @param ctx - Host context owning the trust check.
 * @param handle - admitted request handler.
 * @returns the Node request handler.
 */
function jsonPost(ctx, handle) {
	return async (req, res) => {
		const rejection = ctx.connection.requestRejection(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			res.statusCode = 405;
			res.setHeader('allow', 'POST');
			res.end();
			return;
		}
		if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
			sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' });
			return;
		}
		const body = await readBoundedBody(req);
		if (body === null) {
			sendJson(res, 413, { ok: false, code: 'body-too-large', message: `request body exceeds ${MAX_BODY_BYTES} bytes` });
			return;
		}
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			sendJson(res, 400, { ok: false, code: 'invalid-json', message: 'request body is not JSON' });
			return;
		}
		if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
			sendJson(res, 400, { ok: false, code: 'invalid-request', message: 'request body must be an object' });
			return;
		}
		const answer = await handle(payload).catch((error) => ({
			status: 500,
			body: { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) },
		}));
		sendJson(res, answer.status, answer.body);
	};
}

/** One rejected field, in the envelope's error shape. */
function invalidRequest(message) {
	return { status: 400, body: { ok: false, code: 'invalid-request', message } };
}

/**
 * The route the Client's fork button calls: `{ source, name?, init?, mode? }` in,
 * `{ ok: true, path, workspaceId, branch, mode, copied }` or
 * `{ ok: false, code, message }` out.
 *
 * `mode` is `git` (the default, a plain `git worktree add` checkout) or `copy`
 * (the same checkout, plus every path the source has and it does not). Anything
 * else is a client bug, rejected rather than silently downgraded.
 *
 * @param ctx - Host context owning the registry and the trust check.
 * @returns the Node request handler.
 */
export function forkRoute(ctx) {
	return jsonPost(ctx, async (payload) => {
		if (typeof payload.source !== 'string' || payload.source === '') return invalidRequest('source must be a non-empty path');
		const mode = payload.mode === undefined ? MODE_GIT : payload.mode;
		if (mode !== MODE_GIT && mode !== MODE_COPY) return invalidRequest(`mode must be "${MODE_GIT}" or "${MODE_COPY}"`);
		const outcome = await createWorktreeFork(ctx, {
			source: payload.source,
			mode,
			...(typeof payload.name === 'string' && payload.name !== '' ? { name: payload.name } : {}),
			init: payload.init === true,
		});
		if (outcome.kind === 'success') {
			return {
				status: 200,
				body: {
					ok: true,
					path: outcome.path,
					branch: outcome.branch,
					mode: outcome.mode,
					copied: outcome.copied,
					workspaceId: outcome.workspaceId,
					text: outcome.text,
				},
			};
		}
		return {
			status: 200,
			body: {
				ok: false,
				code: outcome.code,
				message: outcome.text,
				...(outcome.path === undefined ? {} : { path: outcome.path }),
			},
		};
	});
}

/**
 * The route the Client's trash button calls: `{ source, force? }` in,
 * `{ ok: true, path, method }` or `{ ok: false, code, message, path? }` out.
 * `worktree-dirty` is the one failure the Client answers by asking again.
 *
 * @param ctx - Host context owning the registry and the trust check.
 * @returns the Node request handler.
 */
export function removeRoute(ctx) {
	return jsonPost(ctx, async (payload) => {
		if (typeof payload.source !== 'string' || payload.source === '') return invalidRequest('source must be a non-empty path');
		const outcome = await removeWorkspaceFolder(ctx, { source: payload.source, force: payload.force === true });
		if (outcome.kind === 'success') return { status: 200, body: { ok: true, path: outcome.path, method: outcome.method, text: outcome.text } };
		return {
			status: 200,
			body: {
				ok: false,
				code: outcome.code,
				message: outcome.text,
				...(outcome.path === undefined ? {} : { path: outcome.path }),
			},
		};
	});
}

/**
 * Register the human command the same operation serves: a second caller beside
 * the Client button, typed into the composer of the workspace to fork. `--copy`
 * selects the creation mode the dialog offers as its second choice.
 *
 * @param ctx - Host context carrying the command registry.
 */
export function apply(ctx) {
	ctx.commands.register({
		name: COMMAND,
		description: "Create a git worktree of this Session's workspace and register it as a new workspace",
		input: { hint: '[<name>] [--init] [--copy]' },
		handler: async (invocation) => {
			const parsed = parseArguments(invocation.rawInput);
			if (parsed.error !== undefined) return { kind: 'error', text: parsed.error };
			const source = sessionCwd(invocation.agent);
			if (source === undefined) return { kind: 'error', text: 'this Session records no working directory' };
			const outcome = await createWorktreeFork(ctx, {
				source,
				mode: parsed.mode,
				...(parsed.name === undefined ? {} : { name: parsed.name }),
				init: parsed.init,
			});
			return outcome.kind === 'success' ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text };
		},
	});
	ctx.effect(
		() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: forkRoute(ctx) }),
		`fork-worktree: POST ${ROUTE_PATH}`,
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: 'exact', path: REMOVE_ROUTE_PATH, handler: removeRoute(ctx) }),
		`fork-worktree: POST ${REMOVE_ROUTE_PATH}`,
	);
	ctx.effect(() => watchRemovedWorktrees(ctx), 'fork-worktree: removed-worktree sweep');
}
