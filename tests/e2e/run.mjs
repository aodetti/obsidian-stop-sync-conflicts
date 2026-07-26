/**
 * End-to-end tests against a real running Obsidian.
 *
 * Start Obsidian with:  open -a Obsidian --args --remote-debugging-port=9222
 * then:                 npm run test:e2e
 *
 * Sync states are injected by handing the plugin's monitor a stand-in object
 * that satisfies the same structural interface as Obsidian's internal sync
 * instance. Nothing test-only exists in the shipped plugin code.
 */

import { CdpSession, findRendererTarget, sleep } from './cdp.mjs';

const PLUGIN_ID = 'stop-sync-conflicts';
const NOTE_A = 'ConflictGuard Test A.md';
const NOTE_B = 'ConflictGuard Test B.md';
const SCRATCH = 'ConflictGuard Scratch.md';
const NOTES = [NOTE_A, NOTE_B, SCRATCH];

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ✔ ${name}`);
	} catch (error) {
		failed++;
		failures.push({ name, error });
		console.log(`  ✖ ${name}\n      ${error.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message} (expected ${expected}, got ${actual})`);
	}
}

/** Installed once; builds fake sync instances inside the page. */
const HARNESS = `
window.__ssc = {
	current: null,
	makeFake(state) {
		return {
			_handlers: new Set(),
			status: state.status ?? 'synced',
			syncStatus: state.syncStatus ?? '',
			// The real sync instance reports "" when idle, not null.
			syncingPath: state.syncingPath ?? '',
			newServerFiles: (state.pending ?? []).map((path) => ({ path })),
			initial: state.initial ?? false,
			getStatus() { return this.status; },
			on(_name, callback) { this._handlers.add(callback); return callback; },
			offref(ref) { this._handlers.delete(ref); },
			fire() { for (const handler of [...this._handlers]) handler(); },
			patch(next) {
				if (next.pending !== undefined) {
					this.newServerFiles = next.pending.map((path) => ({ path }));
					delete next.pending;
				}
				Object.assign(this, next);
				this.fire();
			},
		};
	},
	plugin() { return window.app.plugins.plugins['${PLUGIN_ID}']; },
	install(state) {
		const fake = this.makeFake(state);
		this.current = fake;
		this.plugin().monitor.setMock(fake);
		return true;
	},
	patch(next) { this.current.patch(next); return true; },
	restore() { this.plugin().monitor.setMock(null); this.current = null; return true; },
	view() { return window.app.workspace.getActiveViewOfType(window.__sscMarkdownView); },
	overlay() { return document.querySelector('.stop-sync-conflicts-overlay'); },
};
true;
`;

async function main() {
	console.log('Connecting to Obsidian…');
	const target = await findRendererTarget();
	const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);

	try {
		await setUp(cdp);
		await runTests(cdp);
	} finally {
		await tearDown(cdp);
		cdp.close();
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.log('\nFailures:');
		for (const failure of failures) {
			console.log(`  ${failure.name}: ${failure.error.message}`);
		}
		process.exit(1);
	}
}

async function setUp(cdp) {
	const loaded = await cdp.evaluate(`
		return !!window.app?.plugins?.plugins['${PLUGIN_ID}'];
	`);
	assert(loaded, `Plugin "${PLUGIN_ID}" is not loaded. Enable it in Obsidian first.`);

	// MarkdownView isn't a global; grab the constructor off a live instance.
	await cdp.evaluate(`
		const leaf = window.app.workspace.getLeavesOfType('markdown')[0];
		if (leaf) window.__sscMarkdownView = leaf.view.constructor;
		return true;
	`);

	await cdp.evaluate(HARNESS);

	for (const path of NOTES) {
		await cdp.evaluate(`
			const existing = window.app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (!existing) {
				await window.app.vault.create(${JSON.stringify(path)}, 'seed\\n');
			}
			return true;
		`);
	}

	await cdp.evaluate(`
		window.__sscOriginalTimeout = window.__ssc.plugin().settings.timeoutSeconds;
		return true;
	`);
}

async function tearDown(cdp) {
	try {
		await cdp.evaluate(`
			const plugin = window.__ssc?.plugin?.();
			if (plugin) {
				plugin.releaseAllHolds();
				plugin.monitor.setMock(null);
				if (window.__sscOriginalTimeout !== undefined) {
					plugin.settings.timeoutSeconds = window.__sscOriginalTimeout;
				}
			}
			for (const path of ${JSON.stringify(NOTES)}) {
				const file = window.app.vault.getAbstractFileByPath(path);
				if (file) await window.app.vault.trash(file, false);
			}
			return true;
		`);
	} catch (error) {
		console.log(`  (cleanup warning: ${error.message})`);
	}
}

/**
 * Opens a note in source mode and waits for the guard to have run.
 *
 * Obsidian does not fire `file-open` when you re-open the note that is already
 * active, so each test navigates via a scratch note first. That also matches
 * the real situation: the user is arriving at the note from somewhere else.
 */
async function openNote(cdp, path) {
	if (path !== SCRATCH) await rawOpen(cdp, SCRATCH);
	await rawOpen(cdp, path);
	await sleep(400);
}

async function rawOpen(cdp, path) {
	await cdp.evaluate(`
		const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(path)});
		const leaf = window.app.workspace.getLeaf(false);
		await leaf.setViewState({
			type: 'markdown',
			state: { file: ${JSON.stringify(path)}, mode: 'source', source: false },
			active: true,
		});
		return true;
	`);
	await sleep(150);
}

const hasOverlay = (cdp) =>
	cdp.evaluate(`return !!document.querySelector('.stop-sync-conflicts-overlay');`);

const noteText = (cdp) =>
	cdp.evaluate(`
		const view = window.app.workspace.getActiveViewOfType(window.__sscMarkdownView);
		return view ? view.editor.getValue() : null;
	`);

/**
 * Focuses the editor and sends real keystrokes, including the keys CodeMirror
 * handles through its keymap rather than through input events.
 * Returns whether the note changed.
 */
async function tryToType(cdp, text) {
	const before = await noteText(cdp);
	await cdp.evaluate(`
		const view = window.app.workspace.getActiveViewOfType(window.__sscMarkdownView);
		view.editor.focus();
		view.editor.setCursor({ line: 0, ch: 0 });
		return true;
	`);
	await sleep(120);
	await cdp.typeText(text);
	await cdp.pressKey('Enter', 13);
	await cdp.pressKey('Backspace', 8);
	await sleep(250);
	const after = await noteText(cdp);
	return { before, after, changed: before !== after };
}

async function runTests(cdp) {
	console.log('\nRule 1 — sync disabled');
	await test('no overlay and editing works when sync is off', async () => {
		await cdp.evaluate(`window.__ssc.plugin().monitor.setMock('disabled'); return true;`);
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), false, 'overlay should not appear');
		const typed = await tryToType(cdp, 'hello');
		assert(typed.changed, 'typing should be allowed');
	});

	console.log('\nRule 2 — sync enabled, nothing to wait for');
	for (const [label, state] of [
		['vault not connected', { status: 'disconnected' }],
		['fully synced', { status: 'synced', syncStatus: 'Fully synced' }],
		[
			'paused with a change waiting',
			{ status: 'paused', syncStatus: 'Paused', pending: [NOTE_A] },
		],
		[
			'a different note is downloading',
			{ status: 'syncing', pending: [NOTE_B], syncingPath: NOTE_B },
		],
	]) {
		await test(`no overlay when ${label}`, async () => {
			await settle(cdp, state);
			await openNote(cdp, NOTE_A);
			assertEqual(await hasOverlay(cdp), false, 'overlay should not appear');
			const typed = await tryToType(cdp, 'x');
			assert(typed.changed, 'typing should be allowed');
		});
	}

	await test('sync error lets the user edit immediately', async () => {
		await cdp.evaluate(
			`window.__ssc.install({ status: 'error', syncStatus: 'Error' }); return true;`,
		);
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), false, 'overlay should not appear');
		const typed = await tryToType(cdp, 'x');
		assert(typed.changed, 'typing should be allowed');
	});

	console.log('\nRule 2.1 — the file is still syncing');
	await test('holds the note when a change for it is waiting', async () => {
		await settle(cdp, {
			status: 'syncing',
			syncStatus: `Downloading ${NOTE_A}`,
			pending: [NOTE_A],
		});
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');
	});

	await test('real keystrokes cannot change a held note', async () => {
		const typed = await tryToType(cdp, 'CONFLICT');
		assert(
			!typed.changed,
			`note was modified while held: ${JSON.stringify(typed.after)}`,
		);
	});

	await test('the editor is marked not editable while held', async () => {
		const editable = await cdp.evaluate(`
			const view = window.app.workspace.getActiveViewOfType(window.__sscMarkdownView);
			return view.editor.cm.contentDOM.getAttribute('contenteditable');
		`);
		assertEqual(editable, 'false', 'contenteditable should be false');
	});

	await test('the banner explains why and counts down', async () => {
		const banner = await cdp.evaluate(`
			const overlay = document.querySelector('.stop-sync-conflicts-overlay');
			return {
				detail: overlay.querySelector('.stop-sync-conflicts-detail')?.textContent ?? '',
				countdown: overlay.querySelector('.stop-sync-conflicts-countdown')?.textContent ?? '',
				button: overlay.querySelector('.stop-sync-conflicts-button')?.textContent ?? '',
			};
		`);
		assert(banner.detail.length > 0, 'banner should explain the hold');
		assert(
			/Giving up in \d+s/.test(banner.countdown),
			`countdown was "${banner.countdown}"`,
		);
		assertEqual(banner.button, 'Edit anyway', 'escape hatch should be offered');
	});

	console.log('\nRule 2.1.1 — released once the file is synced');
	await test('the overlay disappears when sync finishes', async () => {
		await cdp.evaluate(`
			window.__ssc.patch({ status: 'synced', syncStatus: 'Fully synced', pending: [], syncingPath: '' });
			return true;
		`);
		await sleep(600);
		assertEqual(await hasOverlay(cdp), false, 'overlay should be gone');
	});

	await test('editing works again after release', async () => {
		const typed = await tryToType(cdp, 'now editable');
		assert(typed.changed, 'typing should be allowed after release');
	});

	await test('contenteditable is restored to its original value', async () => {
		const editable = await cdp.evaluate(`
			const view = window.app.workspace.getActiveViewOfType(window.__sscMarkdownView);
			return view.editor.cm.contentDOM.getAttribute('contenteditable');
		`);
		assertEqual(editable, 'true', 'editor should be writable again');
	});

	await test('holds while this note is the one being transferred', async () => {
		await settle(cdp, {
			status: 'syncing',
			syncStatus: `Downloading ${NOTE_A}`,
			syncingPath: NOTE_A,
		});
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');
		await cdp.evaluate(
			`window.__ssc.patch({ status: 'synced', syncingPath: '' }); return true;`,
		);
		await sleep(600);
		assertEqual(await hasOverlay(cdp), false, 'overlay should clear');
	});

	console.log('\nConservative hold while sync state is unknown');
	await test('holds at startup before sync has reported anything', async () => {
		await cdp.evaluate(`
			window.__ssc.install({ status: 'syncing', syncStatus: 'Indexing...', initial: true, pending: [] });
			return true;
		`);
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');
	});

	await test('releases once sync reports it has caught up', async () => {
		await cdp.evaluate(`
			window.__ssc.patch({ initial: false, status: 'synced', syncStatus: 'Fully synced' });
			return true;
		`);
		await sleep(600);
		assertEqual(await hasOverlay(cdp), false, 'overlay should clear');
	});

	console.log('\nRule 2.1.2 — the 10 second timeout');
	await test('gives up after the timeout and lets the user edit', async () => {
		await cdp.evaluate(`window.__ssc.plugin().settings.timeoutSeconds = 2; return true;`);
		await cdp.evaluate(`
			window.__ssc.install({ status: 'syncing', syncStatus: 'Connecting to server', initial: true });
			return true;
		`);
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');

		await sleep(2600);
		assertEqual(await hasOverlay(cdp), false, 'overlay should clear after timeout');

		const typed = await tryToType(cdp, 'offline edit');
		assert(typed.changed, 'typing should be allowed after the timeout');
	});

	await test('warns about possible conflicts when it gives up', async () => {
		const warned = await cdp.evaluate(`
			return [...document.querySelectorAll('.notice')]
				.some((el) => /may create a sync conflict/i.test(el.textContent));
		`);
		assert(warned, 'a conflict warning notice should be shown');
	});

	console.log('\nEscape hatch and cleanup');
	await test('"Edit anyway" releases the note immediately', async () => {
		await cdp.evaluate(`window.__ssc.plugin().settings.timeoutSeconds = 60; return true;`);
		await settle(cdp, {
			status: 'syncing',
			syncStatus: 'Downloading',
			pending: [NOTE_A],
		});
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');

		await cdp.evaluate(`
			document.querySelector('.stop-sync-conflicts-button').click();
			return true;
		`);
		await sleep(400);
		assertEqual(await hasOverlay(cdp), false, 'overlay should clear on override');

		const typed = await tryToType(cdp, 'override');
		assert(typed.changed, 'typing should be allowed after overriding');
	});

	await test('navigating away while held leaves nothing behind', async () => {
		await settle(cdp, {
			status: 'syncing',
			syncStatus: 'Downloading',
			pending: [NOTE_A],
		});
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');

		await openNote(cdp, NOTE_B);
		await sleep(600);

		const leftovers = await cdp.evaluate(`
			return {
				overlays: document.querySelectorAll('.stop-sync-conflicts-overlay').length,
				hosts: document.querySelectorAll('.stop-sync-conflicts-host').length,
			};
		`);
		assertEqual(leftovers.overlays, 0, 'no overlay should remain');
		assertEqual(leftovers.hosts, 0, 'no host class should remain');

		const typed = await tryToType(cdp, 'other note');
		assert(typed.changed, 'the other note should be editable');
	});

	await test('turning the plugin off releases everything', async () => {
		await settle(cdp, {
			status: 'syncing',
			syncStatus: 'Downloading',
			pending: [NOTE_A],
		});
		await openNote(cdp, NOTE_A);
		assertEqual(await hasOverlay(cdp), true, 'overlay should appear');

		await cdp.evaluate(`
			const plugin = window.__ssc.plugin();
			plugin.settings.enabled = false;
			plugin.releaseAllHolds();
			return true;
		`);
		await sleep(400);
		assertEqual(await hasOverlay(cdp), false, 'overlay should clear');

		const typed = await tryToType(cdp, 'disabled');
		assert(typed.changed, 'typing should be allowed once disabled');

		await cdp.evaluate(`window.__ssc.plugin().settings.enabled = true; return true;`);
	});

	await test('the activity log records the decisions', async () => {
		const text = await cdp.evaluate(`return window.__ssc.plugin().activity.toText();`);
		assert(text.includes('pending-remote-change'), 'holds should be recorded');
		assert(text.includes('timeout'), 'the timeout should be recorded');
	});
}

/**
 * Installs a fully-synced fake first and lets the monitor observe it, so the
 * plugin has seen a settled vault — the same order real sync goes through —
 * then applies the state under test.
 */
async function settle(cdp, state) {
	await cdp.evaluate(`
		window.__ssc.install({ status: 'synced', syncStatus: 'Fully synced' });
		return true;
	`);
	await sleep(350);
	await cdp.evaluate(`window.__ssc.patch(${JSON.stringify(state)}); return true;`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
