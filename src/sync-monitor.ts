/**
 * Keeps a live view of sync state: resolves the internal instance, follows its
 * `status-change` events, and remembers whether the vault has ever reached a
 * fully-synced state (which is what makes the pending queue trustworthy).
 */

import type { App } from 'obsidian';
import {
	isSettledSnapshot,
	readSnapshot,
	resolveSyncInstance,
	type SyncInstance,
	type SyncSnapshot,
} from './sync-api';

/** How often we re-check, as a safety net around the event subscription. */
const POLL_INTERVAL_MS = 250;

export class SyncMonitor {
	private instance: SyncInstance | null = null;
	private eventRef: unknown = null;
	private mock: SyncInstance | 'disabled' | null = null;
	private settled = false;
	private pollHandle: number | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly log: (message: string) => void,
	) {}

	start(): void {
		this.rebind();
		this.pollHandle = window.setInterval(() => this.tick(), POLL_INTERVAL_MS);
	}

	stop(): void {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
		this.unbind();
		this.listeners.clear();
		this.mock = null;
	}

	/**
	 * Swap in a fake sync instance for the simulation harness (dev commands).
	 * `'disabled'` simulates the core sync plugin being switched off; `null`
	 * goes back to the real instance.
	 */
	setMock(mock: SyncInstance | 'disabled' | null): void {
		this.mock = mock;
		this.settled = false;
		this.rebind();
		this.emit();
	}

	isMocked(): boolean {
		return this.mock !== null;
	}

	onChange(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	getSnapshot(): SyncSnapshot | null {
		const instance = this.resolve();
		if (!instance) return null;
		return readSnapshot(instance, this.settled);
	}

	private resolve(): SyncInstance | null {
		if (this.mock === 'disabled') return null;
		return this.mock ?? resolveSyncInstance(this.app);
	}

	private tick(): void {
		const current = this.resolve();
		if (current !== this.instance) {
			this.rebind();
			this.emit();
			return;
		}
		this.refreshSettled();
	}

	private rebind(): void {
		this.unbind();
		const instance = this.resolve();
		this.instance = instance;
		if (!instance) return;

		try {
			this.eventRef = instance.on('status-change', () => {
				this.refreshSettled();
				this.emit();
			});
		} catch (error) {
			this.log(`could not subscribe to sync events: ${String(error)}`);
			this.eventRef = null;
		}
		this.refreshSettled();
	}

	private unbind(): void {
		if (this.instance && this.eventRef !== null) {
			try {
				this.instance.offref(this.eventRef);
			} catch {
				/* instance already torn down */
			}
		}
		this.instance = null;
		this.eventRef = null;
	}

	/**
	 * `settled` latches on once we have seen a caught-up vault, and resets if
	 * sync drops back to a state where the pending queue is rebuilt from
	 * scratch (disconnect, or a fresh handshake).
	 */
	private refreshSettled(): void {
		const instance = this.resolve();
		if (!instance) {
			this.settled = false;
			return;
		}
		const snapshot = readSnapshot(instance, this.settled);
		if (!snapshot) {
			this.settled = false;
			return;
		}
		if (
			snapshot.status === 'uninitialized' ||
			snapshot.status === 'disconnected' ||
			!snapshot.handshaken
		) {
			this.settled = false;
			return;
		}
		if (isSettledSnapshot(snapshot)) {
			this.settled = true;
		}
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				this.log(`listener failed: ${String(error)}`);
			}
		}
	}
}
