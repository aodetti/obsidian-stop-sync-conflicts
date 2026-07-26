/**
 * A stand-in for the internal sync instance, so every branch of the gate can be
 * exercised without a sync subscription or a second device.
 *
 * Only used when "Simulation commands" is enabled in settings.
 */

import type { SyncInstance, SyncServerFile, SyncStatus } from './sync-api';

export class MockSync implements SyncInstance {
	syncStatus = 'Fully synced';
	syncingPath: string | null = null;
	newServerFiles: SyncServerFile[] = [];
	initial = false;

	private status: SyncStatus = 'synced';
	private readonly handlers = new Set<() => void>();
	private readonly timers: number[] = [];

	getStatus(): SyncStatus {
		return this.status;
	}

	on(_name: 'status-change', callback: () => void): unknown {
		this.handlers.add(callback);
		return callback;
	}

	offref(ref: unknown): void {
		this.handlers.delete(ref as () => void);
	}

	setState(patch: {
		status?: SyncStatus;
		syncStatus?: string;
		syncingPath?: string | null;
		pending?: string[];
		initial?: boolean;
	}): this {
		if (patch.status !== undefined) this.status = patch.status;
		if (patch.syncStatus !== undefined) this.syncStatus = patch.syncStatus;
		if (patch.syncingPath !== undefined) this.syncingPath = patch.syncingPath;
		if (patch.initial !== undefined) this.initial = patch.initial;
		if (patch.pending !== undefined) {
			this.newServerFiles = patch.pending.map((path) => ({ path }));
		}
		this.trigger();
		return this;
	}

	/** Schedules a later state change, used to script "resolves in N seconds". */
	after(delayMs: number, change: () => void): this {
		this.timers.push(
			window.setTimeout(() => {
				change();
				this.trigger();
			}, delayMs),
		);
		return this;
	}

	trigger(): void {
		for (const handler of [...this.handlers]) {
			handler();
		}
	}

	dispose(): void {
		for (const timer of this.timers) window.clearTimeout(timer);
		this.timers.length = 0;
		this.handlers.clear();
	}
}

export interface Scenario {
	id: string;
	name: string;
	/** Expected user-visible behaviour, shown in the notice when it starts. */
	expectation: string;
	/**
	 * The state the mock is installed with. `'disabled'` simulates the core
	 * sync plugin being off, `null` restores the real instance.
	 */
	build(activePath: string | null): MockSync | 'disabled' | null;
	/**
	 * Applied immediately after installation. Scenarios that depend on sync
	 * having already caught up once use this to install a fully-synced mock
	 * first — the same order real sync goes through — and only then start the
	 * incoming change.
	 */
	then?(mock: MockSync, activePath: string | null): void;
}

const syncedBase = (): MockSync =>
	new MockSync().setState({
		status: 'synced',
		syncStatus: 'Fully synced',
		initial: false,
		pending: [],
		syncingPath: null,
	});

export const SCENARIOS: Scenario[] = [
	{
		id: 'real',
		name: 'Use real sync',
		expectation: 'Simulation off — back to the real sync state.',
		build: () => null,
	},
	{
		id: 'disabled',
		name: 'Simulate: sync turned off',
		expectation: 'Notes should open immediately, with no banner.',
		build: () => 'disabled',
	},
	{
		id: 'disconnected',
		name: 'Simulate: sync on but vault not connected',
		expectation: 'Notes should open immediately, with no banner.',
		build: () =>
			new MockSync().setState({ status: 'disconnected', syncStatus: '' }),
	},
	{
		id: 'paused',
		name: 'Simulate: sync paused',
		expectation: 'Notes should open immediately, with no banner.',
		build: () => new MockSync().setState({ status: 'paused', syncStatus: 'Paused' }),
	},
	{
		id: 'synced',
		name: 'Simulate: fully synced',
		expectation: 'Notes should open immediately, with no banner.',
		build: () => syncedBase(),
	},
	{
		id: 'pending-resolves',
		name: 'Simulate: incoming change, arrives after 3s',
		expectation: 'The note should be held for ~3s, then released.',
		build: () => syncedBase(),
		then: (mock, activePath) => {
			mock.setState({
				status: 'syncing',
				syncStatus: `Downloading ${activePath ?? ''}`,
				pending: activePath ? [activePath] : [],
			});
			mock.after(3000, () => {
				mock.newServerFiles = [];
				mock.syncingPath = null;
				mock.syncStatus = 'Fully synced';
				mock.setState({ status: 'synced' });
			});
		},
	},
	{
		id: 'transferring',
		name: 'Simulate: this note downloading now, done after 2s',
		expectation: 'The note should be held for ~2s, then released.',
		build: () => syncedBase(),
		then: (mock, activePath) => {
			mock.setState({
				status: 'syncing',
				syncStatus: `Downloading ${activePath ?? ''}`,
				syncingPath: activePath,
			});
			mock.after(2000, () => {
				mock.syncingPath = null;
				mock.syncStatus = 'Fully synced';
				mock.setState({ status: 'synced' });
			});
		},
	},
	{
		id: 'offline',
		name: 'Simulate: offline at startup, sync never finishes',
		expectation:
			'The note should be held until the timeout, then released with a conflict warning.',
		build: () =>
			new MockSync().setState({
				status: 'syncing',
				syncStatus: 'Connecting to server',
				initial: true,
				pending: [],
			}),
	},
	{
		id: 'offline-known-change',
		name: 'Simulate: offline with a known incoming change',
		expectation:
			'The note should be held until the timeout, then released with a conflict warning.',
		build: () => syncedBase(),
		then: (mock, activePath) => {
			mock.setState({
				status: 'syncing',
				syncStatus: 'Connecting to server',
				pending: activePath ? [activePath] : [],
			});
		},
	},
	{
		id: 'initial-index',
		name: 'Simulate: startup, still checking server, settles after 4s',
		expectation: 'The note should be held for ~4s, then released.',
		build: () =>
			new MockSync().setState({
				status: 'syncing',
				syncStatus: 'Indexing...',
				initial: true,
				pending: [],
			}),
		then: (mock) => {
			mock.after(4000, () => {
				mock.initial = false;
				mock.syncStatus = 'Fully synced';
				mock.setState({ status: 'synced' });
			});
		},
	},
	{
		id: 'error',
		name: 'Simulate: sync error',
		expectation: 'The note should open immediately, with a warning notice.',
		build: () => new MockSync().setState({ status: 'error', syncStatus: 'Error' }),
	},
	{
		id: 'other-file-pending',
		name: 'Simulate: a different note has an incoming change',
		expectation: 'This note should open immediately — the change is elsewhere.',
		build: () => syncedBase(),
		then: (mock) => {
			mock.setState({
				status: 'syncing',
				syncStatus: 'Downloading Some/Other/note.md',
				pending: ['Some/Other/note.md'],
			});
		},
	},
];
