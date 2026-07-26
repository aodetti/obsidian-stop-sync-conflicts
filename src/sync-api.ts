/**
 * Obsidian Sync has no public API. Everything this plugin knows about sync
 * lives in this file so the rest of the codebase can stay on typed, stable
 * concepts and a future Obsidian release can only break one module.
 *
 * The shapes below were read off the shipping desktop/mobile bundle
 * (`app.internalPlugins.plugins.sync.instance`). Every field is optional and
 * every access is feature-detected: if Obsidian changes, the plugin degrades
 * to "don't block anything" rather than locking the user out of their notes.
 */

export const SYNC_PLUGIN_ID = 'sync';

/**
 * Mirrors the sync instance's own `getStatus()`:
 *   uninitialized - plugin hasn't loaded its data yet
 *   disconnected  - loaded, but this vault isn't connected to a remote vault
 *   error         - last sync pass threw, or files are queued for retry
 *   paused        - the user paused syncing
 *   syncing       - a sync pass is running right now
 *   synced        - connected, idle, nothing outstanding
 */
export type SyncStatus =
	| 'uninitialized'
	| 'disconnected'
	| 'error'
	| 'paused'
	| 'syncing'
	| 'synced';

/** An entry in the pending-remote-changes queue (`newServerFiles`). */
export interface SyncServerFile {
	path: string;
	folder?: boolean;
	deleted?: boolean;
}

/** The subset of the internal sync instance this plugin touches. */
export interface SyncInstance {
	getStatus(): SyncStatus;
	/** Human-readable detail, e.g. "Downloading Notes/foo.md" or "Fully synced". */
	syncStatus?: string;
	/** Path currently being transferred, if any. */
	syncingPath?: string | null;
	/** Remote changes received but not yet applied to the local file. */
	newServerFiles?: SyncServerFile[];
	/** True until the first successful handshake with the server. */
	initial?: boolean;
	on(name: 'status-change', callback: () => void): unknown;
	offref(ref: unknown): void;
}

/** Everything the decision logic needs, captured at one instant. */
export interface SyncSnapshot {
	status: SyncStatus;
	statusText: string;
	syncingPath: string | null;
	pendingPaths: Set<string>;
	/** The instance has completed its first handshake (`initial === false`). */
	handshaken: boolean;
	/** We have observed a fully-synced state since the plugin loaded. */
	settled: boolean;
}

interface InternalPluginHandle {
	enabled?: boolean;
	instance?: unknown;
}

interface InternalPluginsHost {
	internalPlugins?: {
		getPluginById?(id: string): InternalPluginHandle | null;
	};
}

/** Structural check - we only accept an object that can answer `getStatus()`. */
function isSyncInstance(value: unknown): value is SyncInstance {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<SyncInstance>;
	return (
		typeof candidate.getStatus === 'function' &&
		typeof candidate.on === 'function' &&
		typeof candidate.offref === 'function'
	);
}

/**
 * Returns the live sync instance, or null when sync is unavailable for any
 * reason: core plugin turned off, not installed, or an API shape we don't
 * recognise. Callers treat null as "sync is disabled - do nothing".
 */
export function resolveSyncInstance(app: unknown): SyncInstance | null {
	try {
		const host = app as InternalPluginsHost;
		const handle = host.internalPlugins?.getPluginById?.(SYNC_PLUGIN_ID);
		if (!handle || handle.enabled !== true) return null;
		return isSyncInstance(handle.instance) ? handle.instance : null;
	} catch {
		return null;
	}
}

/** Reads a snapshot from a live instance, tolerating missing fields. */
export function readSnapshot(
	instance: SyncInstance,
	settled: boolean,
): SyncSnapshot | null {
	let status: SyncStatus;
	try {
		status = instance.getStatus();
	} catch {
		return null;
	}

	const pendingPaths = new Set<string>();
	const queue = instance.newServerFiles;
	if (Array.isArray(queue)) {
		for (const entry of queue) {
			if (entry && typeof entry.path === 'string' && !entry.folder) {
				pendingPaths.add(entry.path);
			}
		}
	}

	// Idle sync reports an empty string here, not null. Normalising matters:
	// "" is not a real path, and treating it as one would stop the vault ever
	// looking settled, which would hold every note until the timeout.
	const syncingPath =
		typeof instance.syncingPath === 'string' && instance.syncingPath.length > 0
			? instance.syncingPath
			: null;

	return {
		status,
		statusText:
			typeof instance.syncStatus === 'string' ? instance.syncStatus : '',
		syncingPath,
		pendingPaths,
		// `initial` missing means an API we don't know; assume handshaken so we
		// fall back to the precise queue check instead of blocking forever.
		handshaken: instance.initial !== true,
		settled,
	};
}

/** True when a snapshot represents a fully caught-up vault. */
export function isSettledSnapshot(snapshot: SyncSnapshot): boolean {
	return (
		snapshot.status === 'synced' &&
		snapshot.pendingPaths.size === 0 &&
		snapshot.syncingPath === null
	);
}
