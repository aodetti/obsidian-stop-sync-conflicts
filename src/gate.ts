/**
 * The decision logic, kept pure so it can be exercised without Obsidian.
 * Given a snapshot of sync state and a file path, decide whether editing that
 * file should be held.
 */

import type { SyncSnapshot } from './sync-api';

export type GateReason =
	| 'sync-disabled'
	| 'sync-not-configured'
	| 'sync-paused'
	| 'sync-error'
	| 'pending-remote-change'
	| 'transferring'
	| 'initial-index'
	| 'up-to-date';

export interface GateDecision {
	/** Hold editing until this clears. */
	block: boolean;
	reason: GateReason;
	/** Short sentence shown in the banner or the debug log. */
	detail: string;
}

export interface GateOptions {
	/**
	 * While sync is connected but hasn't yet reported a fully-synced pass we
	 * cannot know whether the opened file has an update waiting. When true,
	 * hold anyway; when false, only hold on a confirmed pending change.
	 */
	waitDuringInitialIndex: boolean;
}

const ALLOW = (reason: GateReason, detail: string): GateDecision => ({
	block: false,
	reason,
	detail,
});

const HOLD = (reason: GateReason, detail: string): GateDecision => ({
	block: true,
	reason,
	detail,
});

/**
 * `snapshot === null` means sync is disabled or unreadable, which is rule 1:
 * do nothing at all.
 */
export function evaluateGate(
	snapshot: SyncSnapshot | null,
	path: string,
	options: GateOptions,
): GateDecision {
	if (!snapshot) {
		return ALLOW('sync-disabled', 'Obsidian Sync is off.');
	}

	if (snapshot.status === 'uninitialized' || snapshot.status === 'disconnected') {
		return ALLOW(
			'sync-not-configured',
			'This vault is not connected to a remote vault.',
		);
	}

	if (snapshot.status === 'paused') {
		return ALLOW('sync-paused', 'Syncing is paused.');
	}

	// A confirmed incoming change for this exact file - the case we exist for.
	if (snapshot.pendingPaths.has(path)) {
		return HOLD(
			'pending-remote-change',
			'A newer version of this note is waiting to download.',
		);
	}

	if (snapshot.syncingPath === path) {
		return HOLD('transferring', 'This note is syncing right now.');
	}

	// Sync is stuck (offline, auth failure, retry backoff). Waiting cannot help
	// and the timeout message would say the same thing, so let the user work
	// and warn them instead.
	if (snapshot.status === 'error') {
		return ALLOW(
			'sync-error',
			'Sync reported an error, so this note may be out of date.',
		);
	}

	// Connected and busy, but we have never seen a completed pass: the pending
	// queue isn't trustworthy yet, so "no pending entry" doesn't mean "safe".
	const stateIsKnown = snapshot.handshaken && snapshot.settled;
	if (options.waitDuringInitialIndex && !stateIsKnown && snapshot.status === 'syncing') {
		return HOLD('initial-index', 'Checking for changes on the server.');
	}

	return ALLOW('up-to-date', 'This note is up to date.');
}
