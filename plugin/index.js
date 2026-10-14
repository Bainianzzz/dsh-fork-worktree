/**
 * Package entry of the `@local/dsh-fork-worktree` bundle.
 *
 * `entry.js` is what the Loader row names; `impl.js` holds the Host
 * implementation; `client.js` holds the browser half. This entry re-exports the
 * implementation so the package still describes one plugin to any other reader.
 */
export * from './impl.js';
