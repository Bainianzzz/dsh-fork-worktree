/**
 * Package entry of the `dsh-fork-worktree` bundle, and the module the Loader row
 * imports.
 *
 * It is deliberately tiny and is expected to stay unchanged. The Host
 * implementation lives in `./impl.js` and is imported with a per-load nonce
 * instead of being re-exported: ES modules are cached per resolved URL, so a
 * re-export would keep the previous revision in memory when the row is disabled
 * and enabled again in a live profile. With this indirection, editing `impl.js`
 * and toggling the row runs the new revision without restarting the harness.
 */

/** Plugin name for the Loader row. */
export const name = 'fork-worktree';

/** Host capabilities the implementation registers through. */
export const inject = ['commands', 'connection', 'webServer', 'workspaceRegistry'];

/**
 * Import the current implementation and apply it.
 * @param ctx - Host context.
 * @returns the implementation's own apply result.
 */
export async function apply(ctx) {
	const { apply: implementation } = await import(new URL(`./impl.js?load=${String(Date.now())}`, import.meta.url).href);
	return implementation(ctx);
}
