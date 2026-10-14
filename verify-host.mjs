/**
 * Standalone verification for the fork-worktree Host half, run outside DSH.
 *
 * It builds throwaway repositories under `.fork-wt-test/`, then exercises the
 * exported Host pieces with stub contexts: the worktree operation, the browser
 * route handler (including its trust fence and JSON contract), and the
 * removed-worktree sweep.
 *
 * Run with `node verify-host.mjs`. The scratch directory is rebuilt each run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorktreeFork, forkRoute, watchRemovedWorktrees } from './plugin/impl.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '.fork-wt-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = [];
const registry = {
	async create(path) {
		created.push(path);
		return { path, id: `stub-${created.length}` };
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

/* Case 5: the browser route, driven with stub request and response objects. */
const routeCtx = {
	...ctx,
	connection: {
		requestRejection: (req) => (req.headers['host'] === 'untrusted.example' ? 403 : undefined),
	},
};
const handler = forkRoute(routeCtx);
const callRoute = async ({ method = 'POST', contentType = 'application/json', body = '', host = '127.0.0.1:3080' } = {}) => {
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

const untrusted = await callRoute({ host: 'untrusted.example', body: JSON.stringify({ source: repo }) });
check('route refuses an untrusted origin', untrusted.status === 403 && untrusted.body === '', `status=${untrusted.status}`);
const getRoute = await callRoute({ method: 'GET' });
check('route rejects a non-POST method', getRoute.status === 405 && getRoute.headers.allow === 'POST', `status=${getRoute.status}`);
const wrongType = await callRoute({ contentType: 'text/plain', body: '{}' });
check('route requires JSON', wrongType.status === 415 && wrongType.json.code === 'unsupported-media-type');
const badJson = await callRoute({ body: '{' });
check('route rejects malformed JSON', badJson.status === 400 && badJson.json.code === 'invalid-json');
const noSource = await callRoute({ body: '{}' });
check('route requires a source', noSource.status === 400 && noSource.json.code === 'invalid-request');
const stillPlain = join(root, 'still-plain');
mkdirSync(stillPlain);
const notRepoRoute = await callRoute({ body: JSON.stringify({ source: stillPlain }) });
check('route answers not-a-git-repo as data', notRepoRoute.status === 200 && notRepoRoute.json.ok === false && notRepoRoute.json.code === 'not-a-git-repo', JSON.stringify(notRepoRoute.json));
check('route names the directory that needs init', notRepoRoute.json.path === stillPlain);
const initRoute = await callRoute({ body: JSON.stringify({ source: stillPlain, init: true }) });
check('route honors the init flag', initRoute.status === 200 && initRoute.json.ok === true, JSON.stringify(initRoute.json));
const missingRoute = await callRoute({ body: JSON.stringify({ source: join(root, 'absent') }) });
check('route reports a missing directory', missingRoute.status === 200 && missingRoute.json.code === 'source-missing', JSON.stringify(missingRoute.json));
const okRoute = await callRoute({ body: JSON.stringify({ source: repo, name: 'route' }) });
check('route forks', okRoute.status === 200 && okRoute.json.ok === true, JSON.stringify(okRoute.json));
check('route reports path, branch, and workspace', okRoute.json.path === join(root, 'scratch-repo-wt-route') && okRoute.json.branch === 'wt/route' && typeof okRoute.json.workspaceId === 'string', JSON.stringify(okRoute.json));

/* Case 6: the removed-worktree sweep, with a stub registry and a fast period. */
const gone = join(root, 'watched-repo-wt-abc123');
mkdirSync(gone, { recursive: true });
writeFileSync(join(gone, '.git'), 'gitdir: /nowhere\n');
const unrelated = join(root, 'unrelated-dir');
mkdirSync(unrelated, { recursive: true });
const sweepRegistry = {
	rows: [
		{ id: 'tracked', path: gone },
		{ id: 'unrelated', path: unrelated },
		{ id: 'gone-not-mine', path: join(root, 'plain-dir') },
	],
	list() {
		return this.rows;
	},
	deleted: [],
	async delete(id) {
		this.deleted.push(id);
		this.rows = this.rows.filter((row) => row.id !== id);
	},
};
const sweepCtx = { workspaceRegistry: sweepRegistry };
const stopSweep = watchRemovedWorktrees(sweepCtx, 20);
await sleep(60);
check('a live worktree directory is tracked, not removed', sweepRegistry.deleted.length === 0, sweepRegistry.deleted.join(','));
rmSync(gone, { recursive: true, force: true });
await sleep(120);
check('a removed worktree loses its registration', sweepRegistry.deleted.includes('tracked'), sweepRegistry.deleted.join(','));
check('one removal only', sweepRegistry.deleted.filter((id) => id === 'tracked').length === 1);
check('an unrelated directory is left alone', !sweepRegistry.deleted.includes('unrelated'));
rmSync(unrelated, { recursive: true, force: true });
await sleep(120);
check('a missing unrelated directory is left alone', !sweepRegistry.deleted.includes('unrelated'), sweepRegistry.deleted.join(','));

/* Case 6b: a fork deleted while DSH was off is recognized by its generated label. */
const stranded = join(root, 'stranded-repo-wt-4f2a1b');
const strandedRegistry = {
	rows: [{ id: 'stranded', path: stranded }],
	list() {
		return this.rows;
	},
	deleted: [],
	async delete(id) {
		this.deleted.push(id);
		this.rows = [];
	},
};
const stopStranded = watchRemovedWorktrees({ workspaceRegistry: strandedRegistry }, 20);
await sleep(120);
check('a stranded generated-label fork is removed after a restart', strandedRegistry.deleted.includes('stranded'), strandedRegistry.deleted.join(','));
stopStranded();
stopSweep();

/* Case 6c: a directory that is merely named like a fork is left alone. */
const bystander = join(root, 'bystander-wt-notafork');
const bystanderRegistry = {
	rows: [{ id: 'bystander', path: bystander }],
	list() {
		return this.rows;
	},
	deleted: [],
	async delete(id) {
		this.deleted.push(id);
	},
};
const stopBystander = watchRemovedWorktrees({ workspaceRegistry: bystanderRegistry }, 20);
await sleep(120);
check('an unrelated missing directory whose label is not generated stays', bystanderRegistry.deleted.length === 0, bystanderRegistry.deleted.join(','));
stopBystander();

console.log(report.join('\n'));
console.log(`\nworktrees under the scratch repository:\n${git(['worktree', 'list'], repo)}`);
console.log(`\ncreated workspaces in the stub registry: ${created.length}`);
