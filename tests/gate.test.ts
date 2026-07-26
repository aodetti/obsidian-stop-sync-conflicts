import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGate, type GateOptions } from '../src/gate.ts';
import type { SyncSnapshot } from '../src/sync-api.ts';

const CONSERVATIVE: GateOptions = { waitDuringInitialIndex: true };
const PRECISE: GateOptions = { waitDuringInitialIndex: false };

const PATH = 'Notes/meeting.md';

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
	return {
		status: 'synced',
		statusText: 'Fully synced',
		syncingPath: null,
		pendingPaths: new Set<string>(),
		handshaken: true,
		settled: true,
		...overrides,
	};
}

describe('rule 1 - sync disabled', () => {
	it('allows editing when there is no sync instance at all', () => {
		const decision = evaluateGate(null, PATH, CONSERVATIVE);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'sync-disabled');
	});
});

describe('rule 2 - sync enabled but not actually syncing this vault', () => {
	it('allows editing while sync has not initialised', () => {
		const decision = evaluateGate(
			snapshot({ status: 'uninitialized' }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'sync-not-configured');
	});

	it('allows editing when the vault is not connected to a remote vault', () => {
		const decision = evaluateGate(
			snapshot({ status: 'disconnected' }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'sync-not-configured');
	});

	it('allows editing while sync is paused, even with a change waiting', () => {
		// Waiting could never end: paused sync will not fetch the change.
		const decision = evaluateGate(
			snapshot({ status: 'paused', pendingPaths: new Set([PATH]) }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'sync-paused');
	});
});

describe('rule 3 - the file is still syncing', () => {
	it('holds when a remote change for this exact file is queued', () => {
		const decision = evaluateGate(
			snapshot({ status: 'syncing', pendingPaths: new Set([PATH]) }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'pending-remote-change');
	});

	it('holds while this file is the one being transferred', () => {
		const decision = evaluateGate(
			snapshot({ status: 'syncing', syncingPath: PATH }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'transferring');
	});

	it('allows editing when only a different file is queued', () => {
		const decision = evaluateGate(
			snapshot({
				status: 'syncing',
				pendingPaths: new Set(['Other/note.md']),
				syncingPath: 'Other/note.md',
			}),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'up-to-date');
	});

	it('allows editing when the vault is fully synced', () => {
		const decision = evaluateGate(snapshot(), PATH, CONSERVATIVE);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'up-to-date');
	});
});

describe('unknown state - sync connected but nothing confirmed yet', () => {
	it('holds while sync has not reported a finished pass', () => {
		const decision = evaluateGate(
			snapshot({ status: 'syncing', settled: false }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'initial-index');
	});

	it('holds before the first handshake completes', () => {
		const decision = evaluateGate(
			snapshot({ status: 'syncing', handshaken: false, settled: true }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'initial-index');
	});

	it('does not hold on an unknown state when precise mode is chosen', () => {
		const decision = evaluateGate(
			snapshot({ status: 'syncing', settled: false }),
			PATH,
			PRECISE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'up-to-date');
	});

	it('still holds on a confirmed change in precise mode', () => {
		const decision = evaluateGate(
			snapshot({
				status: 'syncing',
				settled: false,
				pendingPaths: new Set([PATH]),
			}),
			PATH,
			PRECISE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'pending-remote-change');
	});

	it('stops holding once sync reports it has caught up', () => {
		const held = evaluateGate(
			snapshot({ status: 'syncing', settled: false }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(held.block, true);

		const released = evaluateGate(
			snapshot({ status: 'synced', settled: true }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(released.block, false);
	});
});

describe('sync errors', () => {
	it('allows editing with a warning, because waiting cannot help', () => {
		const decision = evaluateGate(
			snapshot({ status: 'error', settled: false }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
		assert.equal(decision.reason, 'sync-error');
	});

	it('still holds when a change for this file is known to be waiting', () => {
		// A retry may yet deliver it, and the conflict risk is confirmed.
		const decision = evaluateGate(
			snapshot({ status: 'error', pendingPaths: new Set([PATH]) }),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, true);
		assert.equal(decision.reason, 'pending-remote-change');
	});
});

describe('path matching', () => {
	it('matches on the full vault path, not the file name', () => {
		const decision = evaluateGate(
			snapshot({
				status: 'syncing',
				pendingPaths: new Set(['Archive/meeting.md']),
			}),
			PATH,
			CONSERVATIVE,
		);
		assert.equal(decision.block, false);
	});

	it('every decision carries a human-readable explanation', () => {
		const cases: Array<SyncSnapshot | null> = [
			null,
			snapshot({ status: 'paused' }),
			snapshot({ status: 'syncing', pendingPaths: new Set([PATH]) }),
			snapshot({ status: 'syncing', settled: false }),
			snapshot({ status: 'error' }),
			snapshot(),
		];
		for (const input of cases) {
			const decision = evaluateGate(input, PATH, CONSERVATIVE);
			assert.ok(decision.detail.length > 0, `empty detail for ${decision.reason}`);
		}
	});
});
