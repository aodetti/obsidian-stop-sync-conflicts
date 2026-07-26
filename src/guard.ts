/**
 * Ties everything together: when a note is opened, ask the gate whether it is
 * safe to edit, and if not, hold the view until sync catches up or we time out.
 */

import { MarkdownView, Notice, type TFile } from 'obsidian';
import { EditBlocker } from './edit-blocker';
import { evaluateGate, type GateDecision } from './gate';
import type { StopSyncConflictsSettings } from './settings';
import type { SyncMonitor } from './sync-monitor';

/** How often the countdown and release check run while a note is held. */
const TICK_MS = 250;

/** Below this, releasing is imperceptible and a notice would just be noise. */
const NOTICE_THRESHOLD_MS = 700;

type HoldOutcome = 'cleared' | 'timeout' | 'override' | 'abandoned';

class Hold {
	private readonly blocker: EditBlocker;
	private readonly deadline: number;
	private readonly startedAt = Date.now();
	private readonly disposers: Array<() => void> = [];
	private finished = false;

	constructor(
		private readonly view: MarkdownView,
		readonly path: string,
		decision: GateDecision,
		private readonly settings: StopSyncConflictsSettings,
		private readonly monitor: SyncMonitor,
		private readonly log: (message: string) => void,
		private readonly onFinished: (hold: Hold, outcome: HoldOutcome) => void,
	) {
		this.deadline = this.startedAt + settings.timeoutSeconds * 1000;
		this.blocker = new EditBlocker(view);
		this.blocker.engage({
			detail: decision.detail,
			onEditAnyway: () => this.finish('override'),
		});
		this.blocker.setRemaining(settings.timeoutSeconds);

		this.disposers.push(monitor.onChange(() => this.check()));

		const timer = window.setInterval(() => this.check(), TICK_MS);
		this.disposers.push(() => window.clearInterval(timer));
	}

	/** Ends the hold without any message — the note or view went away. */
	abandon(): void {
		this.finish('abandoned');
	}

	private check(): void {
		if (this.finished) return;

		// The user navigated away, closed the pane, or the file was renamed.
		if (!this.view.contentEl.isConnected || this.view.file?.path !== this.path) {
			this.finish('abandoned');
			return;
		}

		const decision = evaluateGate(this.monitor.getSnapshot(), this.path, {
			waitDuringInitialIndex: this.settings.waitDuringInitialIndex,
		});

		if (!decision.block) {
			this.finish('cleared');
			return;
		}

		this.blocker.setDetail(decision.detail);
		this.blocker.setRemaining(
			Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)),
		);

		if (Date.now() >= this.deadline) {
			this.finish('timeout');
		}
	}

	private finish(outcome: HoldOutcome): void {
		if (this.finished) return;
		this.finished = true;

		for (const dispose of this.disposers) {
			try {
				dispose();
			} catch {
				/* best effort */
			}
		}
		this.blocker.release();

		const elapsed = Date.now() - this.startedAt;
		this.log(`released ${this.path} after ${elapsed}ms (${outcome})`);

		if (outcome !== 'abandoned') {
			// Put the caret back so the user can simply start typing.
			try {
				this.view.editor?.focus();
			} catch {
				/* view may not be editable */
			}
		}

		switch (outcome) {
			case 'cleared':
				if (this.settings.showReadyNotice && elapsed >= NOTICE_THRESHOLD_MS) {
					new Notice('Sync finished — this note is up to date.', 3000);
				}
				break;
			case 'timeout':
				new Notice(
					`Sync did not finish within ${this.settings.timeoutSeconds} seconds. ` +
						'You can edit now, but this note may create a sync conflict later.',
					8000,
				);
				break;
			case 'override':
				new Notice(
					'Editing before sync finished. This note may create a sync conflict later.',
					8000,
				);
				break;
			case 'abandoned':
				break;
		}

		this.onFinished(this, outcome);
	}
}

export class ConflictGuard {
	private readonly holds = new Map<MarkdownView, Hold>();

	constructor(
		private readonly monitor: SyncMonitor,
		private readonly getSettings: () => StopSyncConflictsSettings,
		private readonly log: (message: string) => void,
	) {}

	/** Entry point for the `file-open` / `active-leaf-change` events. */
	guard(view: MarkdownView, file: TFile): void {
		const settings = this.getSettings();
		if (!settings.enabled) return;

		const existing = this.holds.get(view);
		if (existing) {
			if (existing.path === file.path) return;
			existing.abandon();
		}

		const decision = evaluateGate(this.monitor.getSnapshot(), file.path, {
			waitDuringInitialIndex: settings.waitDuringInitialIndex,
		});
		this.log(
			`${file.path}: ${decision.block ? 'hold' : 'allow'} (${decision.reason})`,
		);

		if (!decision.block) {
			if (decision.reason === 'sync-error' && settings.warnOnSyncError) {
				new Notice(
					'Obsidian Sync has an error, so this note may be out of date. Editing it now may cause a conflict.',
					6000,
				);
			}
			return;
		}

		const hold = new Hold(
			view,
			file.path,
			decision,
			settings,
			this.monitor,
			this.log,
			(finished) => {
				if (this.holds.get(view) === finished) this.holds.delete(view);
			},
		);
		this.holds.set(view, hold);
	}

	releaseAll(): void {
		for (const hold of [...this.holds.values()]) {
			hold.abandon();
		}
		this.holds.clear();
	}
}
