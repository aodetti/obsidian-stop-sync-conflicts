import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	isSettledSnapshot,
	readSnapshot,
	resolveSyncInstance,
	type SyncInstance,
} from '../src/sync-api.ts';

function instance(overrides: Partial<SyncInstance> = {}): SyncInstance {
	return {
		getStatus: () => 'synced',
		on: () => ({}),
		offref: () => undefined,
		...overrides,
	};
}

describe('resolveSyncInstance', () => {
	const usable = instance();

	it('returns the instance when the core sync plugin is enabled', () => {
		const app = {
			internalPlugins: {
				getPluginById: () => ({ enabled: true, instance: usable }),
			},
		};
		assert.equal(resolveSyncInstance(app), usable);
	});

	it('returns null when the sync plugin is disabled', () => {
		const app = {
			internalPlugins: {
				getPluginById: () => ({ enabled: false, instance: usable }),
			},
		};
		assert.equal(resolveSyncInstance(app), null);
	});

	it('returns null when sync is not present at all', () => {
		const app = { internalPlugins: { getPluginById: () => null } };
		assert.equal(resolveSyncInstance(app), null);
	});

	it('returns null when the internals are missing entirely', () => {
		assert.equal(resolveSyncInstance({}), null);
		assert.equal(resolveSyncInstance(null), null);
		assert.equal(resolveSyncInstance(undefined), null);
	});

	it('rejects an instance that does not match the expected shape', () => {
		// A future Obsidian could rename these; we must degrade to "do nothing"
		// rather than hold notes on a guess.
		const app = {
			internalPlugins: {
				getPluginById: () => ({ enabled: true, instance: { foo: 1 } }),
			},
		};
		assert.equal(resolveSyncInstance(app), null);
	});

	it('returns null instead of throwing when the lookup throws', () => {
		const app = {
			internalPlugins: {
				getPluginById: () => {
					throw new Error('internal change');
				},
			},
		};
		assert.equal(resolveSyncInstance(app), null);
	});
});

describe('readSnapshot', () => {
	it('collects queued file paths', () => {
		const snapshot = readSnapshot(
			instance({
				getStatus: () => 'syncing',
				newServerFiles: [{ path: 'a.md' }, { path: 'b.md' }],
			}),
			false,
		);
		assert.deepEqual([...(snapshot?.pendingPaths ?? [])], ['a.md', 'b.md']);
	});

	it('ignores folder entries, which cannot be edited', () => {
		const snapshot = readSnapshot(
			instance({
				newServerFiles: [{ path: 'Folder', folder: true }, { path: 'a.md' }],
			}),
			false,
		);
		assert.deepEqual([...(snapshot?.pendingPaths ?? [])], ['a.md']);
	});

	it('treats a deletion of this file as a pending change', () => {
		// Editing a note that is about to be deleted remotely is exactly the
		// conflict case, so deletions stay in the queue.
		const snapshot = readSnapshot(
			instance({ newServerFiles: [{ path: 'a.md', deleted: true }] }),
			false,
		);
		assert.ok(snapshot?.pendingPaths.has('a.md'));
	});

	it('reports handshaken false only while initial is true', () => {
		assert.equal(readSnapshot(instance({ initial: true }), false)?.handshaken, false);
		assert.equal(readSnapshot(instance({ initial: false }), false)?.handshaken, true);
	});

	it('assumes handshaken when the field is missing, to avoid holding forever', () => {
		assert.equal(readSnapshot(instance(), false)?.handshaken, true);
	});

	it('treats the empty syncingPath of an idle sync as no path', () => {
		// The real instance reports "" when idle. Left as-is it would never look
		// settled, and every note would be held until the timeout.
		const snapshot = readSnapshot(instance({ syncingPath: '' }), false);
		assert.ok(snapshot);
		assert.equal(snapshot.syncingPath, null);
		assert.equal(isSettledSnapshot(snapshot), true);
	});

	it('tolerates a missing queue and missing status text', () => {
		const snapshot = readSnapshot(instance(), true);
		assert.equal(snapshot?.pendingPaths.size, 0);
		assert.equal(snapshot?.statusText, '');
		assert.equal(snapshot?.syncingPath, null);
	});

	it('returns null when getStatus throws', () => {
		const snapshot = readSnapshot(
			instance({
				getStatus: () => {
					throw new Error('gone');
				},
			}),
			false,
		);
		assert.equal(snapshot, null);
	});
});

describe('isSettledSnapshot', () => {
	const base = {
		statusText: '',
		syncingPath: null,
		pendingPaths: new Set<string>(),
		handshaken: true,
		settled: false,
	};

	it('is settled only when synced, idle and with an empty queue', () => {
		assert.equal(isSettledSnapshot({ ...base, status: 'synced' }), true);
		assert.equal(isSettledSnapshot({ ...base, status: 'syncing' }), false);
		assert.equal(
			isSettledSnapshot({
				...base,
				status: 'synced',
				pendingPaths: new Set(['a.md']),
			}),
			false,
		);
		assert.equal(
			isSettledSnapshot({ ...base, status: 'synced', syncingPath: 'a.md' }),
			false,
		);
	});
});
