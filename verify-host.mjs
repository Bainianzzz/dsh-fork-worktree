/**
 * Standalone verification for the fork-worktree Host half, run outside DSH.
 *
 * It builds throwaway repositories in a fresh directory under the system temp
 * directory (never inside this workspace, which may itself be a repository the
 * plugin created), then exercises the exported Host pieces with stub contexts:
 * the worktree operation, the removal operation, both browser routes (including
 * their trust fence and JSON contract), and the removed-worktree sweep.
 *
 * Run with `node verify-host.mjs`. The scratch directory is removed at the end.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorktreeFork, forkRoute, removeRoute, removeWorkspaceFolder, watchRemovedWorktrees } from './impl.js';

const here = dirname(fileURLToPath(import.meta.url));
/* Canonical spelling: on macOS the temp directory's /var is a symlink to /private/var, and git reports the target. */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-fork-worktree-verify-')));
mkdirSync(root, { recursive: true });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registry stub: the two methods the Host half uses. */
const created = [];
const deleted = [];
const registry = {
	rows: [],
	async create(path) {
		created.push(path);
		const row = { id: `stub-${created.length}`, path };
		this.rows.push(row);
		return row;
	},
	list() {
		return this.rows;
	},
	async delete(id) {
		deleted.push(id);
		this.rows = this.rows.filter((row) => row.id !== id);
		return true;
	},
};
const ctx = { workspaceRegistry: registry };

const report = [];
const check = (label, condition, detail = '') => {
	report.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
	if (!condition) process.exitCode = 1;
};

/* Case 1: an existing repository. */
const repo = join(root, 'scratch-repo');
mkdirSync(repo);
git(['init', '-b', 'main'], repo);
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'add', '.'], repo);
git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-m', 'initial'], repo);

const first = await createWorktreeFork(ctx, { source: repo, name: 'demo', init: false });
check('existing repo forks', first.kind === 'success', first.text);
check('fork path is a sibling worktree', first.kind === 'success' && first.path === join(root, 'scratch-repo-wt-demo'), first.path);
check('fork path exists', first.kind === 'success' && existsSync(join(first.path, 'README.md')));
check('fork is a linked worktree', first.kind === 'success' && readFileSync(join(first.path, '.git'), 'utf8').startsWith('gitdir:'));
check('fork branch registered', first.kind === 'success' && git(['branch', '--list', first.branch], repo).includes(first.branch), first.branch);
check('stub registry saw the fork', created.length === 1 && created[0] === first.path);
check('success text leads with the path', first.kind === 'success' && first.text.split('\n')[0] === first.path);
check('success reports the workspace id', first.kind === 'success' && first.workspaceId === 'stub-1', first.workspaceId);

/* Case 2: a directory that is not a repository, without initialization. */
const plain = join(root, 'plain-dir');
mkdirSync(plain);
writeFileSync(join(plain, 'notes.txt'), 'x\n');
const refused = await createWorktreeFork(ctx, { source: plain, init: false });
check('non-repo refuses by default', refused.kind === 'error' && refused.code === 'not-a-git-repo', refused.text);
check('refusal names the directory', refused.kind === 'error' && refused.text.slice('not-a-git-repo:'.length).trim() === plain, refused.text);

/* Case 3: the same directory with initialization allowed. */
const initialized = await createWorktreeFork(ctx, { source: plain, init: true });
check('non-repo forks after init', initialized.kind === 'success', initialized.text);
check('source became a repository', existsSync(join(plain, '.git')) && git(['rev-parse', '--show-toplevel'], plain) === plain);
check('init recorded', initialized.kind === 'success' && initialized.text.includes('repository: initialized'), initialized.text);
check('init fork carries the directory content', initialized.kind === 'success' && existsSync(join(initialized.path, 'notes.txt')));
check('init committed the content', initialized.kind === 'success' && git(['ls-files'], initialized.path) === 'notes.txt');

/* Case 3b: an untouched empty directory still yields a worktree. */
const empty = join(root, 'empty-dir');
mkdirSync(empty);
const fromEmpty = await createWorktreeFork(ctx, { source: empty, init: true });
check('empty directory forks after init', fromEmpty.kind === 'success', fromEmpty.text);
check('empty source has a commit', git(['rev-list', '--count', 'HEAD'], empty) === '1');

/* Case 4: the same target twice, and a missing directory. */
const second = await createWorktreeFork(ctx, { source: repo, name: 'demo', init: false });
check('duplicate target refuses', second.kind === 'error' && second.code === 'target-exists', second.text);
const missing = await createWorktreeFork(ctx, { source: join(root, 'nope'), init: false });
check('missing directory reports', missing.kind === 'error' && missing.code === 'source-missing', missing.text);

/* Case 5: the fork route, driven with stub request and response objects. */
const routeCtx = {
	...ctx,
	connection: {
		requestRejection: (req) => (req.headers.host === 'untrusted.example' ? 403 : undefined),
	},
};
const callRoute = async (handler, { method = 'POST', contentType = 'application/json', body = '', host = '127.0.0.1:3080' } = {}) => {
	const request = {
		method,
		headers: { host, ...(contentType === null ? {} : { 'content-type': contentType }) },
		async *[Symbol.asyncIterator]() {
			if (body !== '') yield Buffer.from(body, 'utf8');
		},
		resume() {},
	};
	const captured = { status: 0, headers: {}, body: '' };
	const response = {
		set statusCode(value) {
			captured.status = value;
		},
		get statusCode() {
			return captured.status;
		},
		setHeader: (name, value) => {
			captured.headers[name] = value;
		},
		end: (value) => {
			captured.body = value === undefined ? '' : String(value);
		},
	};
	await handler(request, response);
	return { ...captured, json: captured.body === '' ? undefined : JSON.parse(captured.body) };
};

const fork = forkRoute(routeCtx);
const untrusted = await callRoute(fork, { host: 'untrusted.example', body: JSON.stringify({ source: repo }) });
check('fork route refuses an untrusted origin', untrusted.status === 403 && untrusted.body === '', `status=${untrusted.status}`);
const getFork = await callRoute(fork, { method: 'GET' });
check('fork route rejects a non-POST method', getFork.status === 405 && getFork.headers.allow === 'POST', `status=${getFork.status}`);
const wrongType = await callRoute(fork, { contentType: 'text/plain', body: '{}' });
check('fork route requires JSON', wrongType.status === 415 && wrongType.json.code === 'unsupported-media-type');
const badJson = await callRoute(fork, { body: '{' });
check('fork route rejects malformed JSON', badJson.status === 400 && badJson.json.code === 'invalid-json');
const noSource = await callRoute(fork, { body: '{}' });
check('fork route requires a source', noSource.status === 400 && noSource.json.code === 'invalid-request');
const stillPlain = join(root, 'still-plain');
mkdirSync(stillPlain);
const notRepoRoute = await callRoute(fork, { body: JSON.stringify({ source: stillPlain }) });
check('fork route answers not-a-git-repo as data', notRepoRoute.status === 200 && notRepoRoute.json.ok === false && notRepoRoute.json.code === 'not-a-git-repo', JSON.stringify(notRepoRoute.json));
check('fork route names the directory that needs init', notRepoRoute.json.path === stillPlain);
const initRoute = await callRoute(fork, { body: JSON.stringify({ source: stillPlain, init: true }) });
check('fork route honors the init flag', initRoute.status === 200 && initRoute.json.ok === true, JSON.stringify(initRoute.json));
const missingRoute = await callRoute(fork, { body: JSON.stringify({ source: join(root, 'absent') }) });
check('fork route reports a missing directory', missingRoute.status === 200 && missingRoute.json.code === 'source-missing', JSON.stringify(missingRoute.json));
const okRoute = await callRoute(fork, { body: JSON.stringify({ source: repo, name: 'route' }) });
check('fork route forks', okRoute.status === 200 && okRoute.json.ok === true, JSON.stringify(okRoute.json));
check('fork route reports path, branch, and workspace', okRoute.json.path === join(root, 'scratch-repo-wt-route') && okRoute.json.branch === 'wt/route' && typeof okRoute.json.workspaceId === 'string', JSON.stringify(okRoute.json));

/* Case 6: removal of a clean worktree, and of a plain directory. */
const cleanFork = await createWorktreeFork(ctx, { source: repo, name: 'cleanup', init: false });
const removedWorktree = await removeWorkspaceFolder(ctx, { source: cleanFork.path });
check('clean worktree removes through git', removedWorktree.kind === 'success' && removedWorktree.method === 'worktree-remove', JSON.stringify(removedWorktree));
check('clean worktree directory is gone', !existsSync(cleanFork.path));
check('git forgot the clean worktree', !git(['worktree', 'list'], repo).includes(cleanFork.path));
check('clean worktree registration dropped', registry.rows.every((row) => row.path !== cleanFork.path));

const plainAgain = join(root, 'plain-removal');
mkdirSync(join(plainAgain, 'nested'), { recursive: true });
writeFileSync(join(plainAgain, 'nested', 'file.txt'), 'x\n');
await registry.create(plainAgain);
const removedDirectory = await removeWorkspaceFolder(ctx, { source: plainAgain });
check('plain directory removes as a directory', removedDirectory.kind === 'success' && removedDirectory.method === 'removed-directory', JSON.stringify(removedDirectory));
check('plain directory is gone', !existsSync(plainAgain));
check('plain directory registration dropped', registry.rows.every((row) => row.path !== plainAgain));

/* Case 7: a worktree holding uncommitted content is refused, then forced. */
const dirtyFork = await createWorktreeFork(ctx, { source: repo, name: 'dirty', init: false });
writeFileSync(join(dirtyFork.path, 'scratch.txt'), 'uncommitted\n');
const refusedDirty = await removeWorkspaceFolder(ctx, { source: dirtyFork.path });
check('dirty worktree is refused', refusedDirty.kind === 'error' && refusedDirty.code === 'worktree-dirty', JSON.stringify(refusedDirty));
check('dirty worktree survives the refusal', existsSync(join(dirtyFork.path, 'scratch.txt')));
check('refused worktree keeps its registration', registry.rows.some((row) => row.path === dirtyFork.path));
const forcedDirty = await removeWorkspaceFolder(ctx, { source: dirtyFork.path, force: true });
check('forced worktree removes', forcedDirty.kind === 'success' && forcedDirty.method === 'worktree-remove', JSON.stringify(forcedDirty));
check('forced worktree directory is gone', !existsSync(dirtyFork.path));
check('forced worktree registration dropped', registry.rows.every((row) => row.path !== dirtyFork.path));

/* Case 8: the guards, and the remove route's contract. */
const missingRemoval = await removeWorkspaceFolder(ctx, { source: join(root, 'never-existed') });
check('removal reports a missing directory', missingRemoval.kind === 'error' && missingRemoval.code === 'source-missing', JSON.stringify(missingRemoval));
const homeRemoval = await removeWorkspaceFolder(ctx, { source: homedir() });
check('removal refuses the home directory', homeRemoval.kind === 'error' && homeRemoval.code === 'refused-path', JSON.stringify(homeRemoval));
const rootRemoval = await removeWorkspaceFolder(ctx, { source: '/' });
check('removal refuses the filesystem root', rootRemoval.kind === 'error' && rootRemoval.code === 'refused-path', JSON.stringify(rootRemoval));

const remove = removeRoute(routeCtx);
const untrustedRemove = await callRoute(remove, { host: 'untrusted.example', body: JSON.stringify({ source: repo }) });
check('remove route refuses an untrusted origin', untrustedRemove.status === 403, `status=${untrustedRemove.status}`);
const getRemove = await callRoute(remove, { method: 'GET' });
check('remove route rejects a non-POST method', getRemove.status === 405, `status=${getRemove.status}`);
const noRemoveSource = await callRoute(remove, { body: '{}' });
check('remove route requires a source', noRemoveSource.status === 400 && noRemoveSource.json.code === 'invalid-request');
const routeRemoval = await callRoute(remove, { body: JSON.stringify({ source: first.path }) });
check('remove route removes a worktree', routeRemoval.status === 200 && routeRemoval.json.ok === true && routeRemoval.json.method === 'worktree-remove', JSON.stringify(routeRemoval.json));
check('remove route reports the directory', routeRemoval.json.path === first.path);
const dirtyRouteFork = await createWorktreeFork(ctx, { source: repo, name: 'route-dirty', init: false });
writeFileSync(join(dirtyRouteFork.path, 'wip.txt'), 'x\n');
const dirtyRoute = await callRoute(remove, { body: JSON.stringify({ source: dirtyRouteFork.path }) });
check('remove route answers worktree-dirty as data', dirtyRoute.status === 200 && dirtyRoute.json.code === 'worktree-dirty', JSON.stringify(dirtyRoute.json));
check('remove route names the dirty worktree', dirtyRoute.json.path === dirtyRouteFork.path);
const forcedRoute = await callRoute(remove, { body: JSON.stringify({ source: dirtyRouteFork.path, force: true }) });
check('remove route honors the force flag', forcedRoute.status === 200 && forcedRoute.json.ok === true, JSON.stringify(forcedRoute.json));

/* Case 9: the removed-worktree sweep, with a stub registry and a fast period. */
const gone = join(root, 'watched-repo-wt-abc123');
mkdirSync(gone, { recursive: true });
writeFileSync(join(gone, '.git'), 'gitdir: /nowhere\n');
const unrelated = join(root, 'unrelated-dir');
mkdirSync(unrelated, { recursive: true });
const sweepDeleted = [];
const sweepRegistry = {
	rows: [
		{ id: 'tracked', path: gone },
		{ id: 'unrelated', path: unrelated },
	],
	list() {
		return this.rows;
	},
	async delete(id) {
		sweepDeleted.push(id);
		this.rows = this.rows.filter((row) => row.id !== id);
	},
};
const stopSweep = watchRemovedWorktrees({ workspaceRegistry: sweepRegistry }, 20);
await sleep(60);
check('a live worktree directory is tracked, not removed', sweepDeleted.length === 0, sweepDeleted.join(','));
rmSync(gone, { recursive: true, force: true });
await sleep(120);
check('a removed worktree loses its registration', sweepDeleted.includes('tracked'), sweepDeleted.join(','));
check('one removal only', sweepDeleted.filter((id) => id === 'tracked').length === 1);
check('an unrelated directory is left alone', !sweepDeleted.includes('unrelated'));
rmSync(unrelated, { recursive: true, force: true });
await sleep(120);
check('a missing unrelated directory is left alone', !sweepDeleted.includes('unrelated'), sweepDeleted.join(','));

/* Case 9b: a fork deleted while DSH was off is recognized by its generated label. */
const stranded = join(root, 'stranded-repo-wt-4f2a1b');
const strandedDeleted = [];
const stopStranded = watchRemovedWorktrees(
	{
		workspaceRegistry: {
			rows: [{ id: 'stranded', path: stranded }],
			list() {
				return this.rows;
			},
			async delete(id) {
				strandedDeleted.push(id);
				this.rows = [];
			},
		},
	},
	20,
);
await sleep(120);
check('a stranded generated-label fork is removed after a restart', strandedDeleted.includes('stranded'), strandedDeleted.join(','));
stopStranded();
stopSweep();

/* Case 9c: a directory that is merely named like a fork is left alone. */
const bystanderDeleted = [];
const stopBystander = watchRemovedWorktrees(
	{
		workspaceRegistry: {
			rows: [{ id: 'bystander', path: join(root, 'bystander-wt-notafork') }],
			list() {
				return this.rows;
			},
			async delete(id) {
				bystanderDeleted.push(id);
			},
		},
	},
	20,
);
await sleep(120);
check('an unrelated missing directory whose label is not generated stays', bystanderDeleted.length === 0, bystanderDeleted.join(','));
stopBystander();

console.log(report.join('\n'));
console.log(`\nremovals recorded by the stub registry: ${deleted.length}`);
console.log(`worktrees left under the scratch repository:\n${git(['worktree', 'list'], repo)}`);
rmSync(root, { recursive: true, force: true });
console.log(`\nscratch directory removed: ${root}`);
console.log(`report mentions this checkout at: ${here}`);
