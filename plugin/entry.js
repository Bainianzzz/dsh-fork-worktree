/**
 * Loader row for the `@local/dsh-fork-worktree` bundle.
 *
 * This file is deliberately tiny and is expected to stay unchanged: the Loader
 * row names it by absolute path, and ES modules are cached per resolved URL, so
 * editing this file would not be picked up by a re-enable. The implementation it
 * pulls in is imported with a per-load nonce instead, which is what makes
 * "edit impl.js, then disable/enable the row in the Plugins page" enough to run
 * a new revision of the Host half in a live profile.
 */
export const name = 'fork-worktree';
export const inject = ['commands', 'connection', 'webServer', 'workspaceRegistry'];

/**
 * Import the current implementation and apply it.
 * @param ctx - Host context.
 */
export async function apply(ctx) {
	const { apply: implementation } = await import(new URL(`./impl.js?load=${String(Date.now())}`, import.meta.url).href);
	return implementation(ctx);
}
