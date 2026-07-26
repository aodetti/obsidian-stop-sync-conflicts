/**
 * Makes a Markdown view temporarily unwritable and explains why.
 *
 * Nothing here touches the note's contents - we only stop input from reaching
 * the editor, so releasing the block always leaves the note exactly as it was.
 */

import { MarkdownView, setIcon } from 'obsidian';

/** Events that can mutate a CodeMirror document, in capture order. */
const INPUT_EVENTS = [
	'beforeinput',
	'keydown',
	'keypress',
	'paste',
	'cut',
	'drop',
	'dragover',
	'compositionstart',
] as const;

export interface BlockerOptions {
	detail: string;
	onEditAnyway: () => void;
}

export class EditBlocker {
	private overlayEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private countdownEl: HTMLElement | null = null;
	private contentDom: HTMLElement | null = null;
	private previousEditable: string | null = null;
	private readonly cleanups: Array<() => void> = [];

	constructor(private readonly view: MarkdownView) {}

	get isEngaged(): boolean {
		return this.overlayEl !== null;
	}

	engage(options: BlockerOptions): void {
		if (this.overlayEl) {
			this.setDetail(options.detail);
			return;
		}

		this.suppressInput();
		this.buildOverlay(options);
	}

	setDetail(text: string): void {
		this.detailEl?.setText(text);
	}

	/** `remaining` is seconds left before we give up and let the user type. */
	setRemaining(remaining: number): void {
		if (!this.countdownEl) return;
		this.countdownEl.setText(
			remaining > 0 ? `Giving up in ${remaining}s` : 'Giving up…',
		);
	}

	release(): void {
		while (this.cleanups.length > 0) {
			const cleanup = this.cleanups.pop();
			try {
				cleanup?.();
			} catch {
				/* best effort - keep unwinding */
			}
		}
		this.overlayEl?.remove();
		this.overlayEl = null;
		this.detailEl = null;
		this.countdownEl = null;
		this.contentDom = null;
	}

	/**
	 * Blocks the two ways text reaches CodeMirror: native contenteditable input
	 * (`beforeinput`, paste, IME) and CodeMirror's own keymap, which handles
	 * keys like Backspace and Enter from `keydown` without any input event.
	 *
	 * Shortcuts held with Cmd/Ctrl are let through so the command palette and
	 * other app hotkeys keep working while the note is held.
	 */
	private suppressInput(): void {
		const contentDom = this.resolveContentDom();
		const host = this.view.contentEl;

		if (contentDom) {
			this.contentDom = contentDom;
			this.previousEditable = contentDom.getAttribute('contenteditable');
			contentDom.setAttribute('contenteditable', 'false');
			this.cleanups.push(() => {
				if (this.previousEditable === null) {
					contentDom.removeAttribute('contenteditable');
				} else {
					contentDom.setAttribute('contenteditable', this.previousEditable);
				}
			});

			// Move the caret out so queued keystrokes have nowhere to land.
			if (contentDom.contains(activeDocument.activeElement)) {
				(activeDocument.activeElement as HTMLElement | null)?.blur();
			}
		}

		const handler = (event: Event) => {
			const target = event.target as Node | null;
			if (this.overlayEl && target && this.overlayEl.contains(target)) return;
			if (this.contentDom && target && !this.contentDom.contains(target)) return;

			if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey)) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
		};

		for (const name of INPUT_EVENTS) {
			host.addEventListener(name, handler, true);
			this.cleanups.push(() => host.removeEventListener(name, handler, true));
		}
	}

	private resolveContentDom(): HTMLElement | null {
		const editor = this.view.editor as unknown as
			| { cm?: { contentDOM?: HTMLElement } }
			| undefined;
		const dom = editor?.cm?.contentDOM;
		return dom instanceof HTMLElement ? dom : null;
	}

	private buildOverlay(options: BlockerOptions): void {
		const host = this.view.contentEl;
		host.addClass('stop-sync-conflicts-host');
		this.cleanups.push(() => host.removeClass('stop-sync-conflicts-host'));

		const overlay = host.createDiv({ cls: 'stop-sync-conflicts-overlay' });
		this.overlayEl = overlay;

		// Swallow taps and clicks so the caret can never be placed underneath.
		const swallow = (event: Event) => {
			if (event.target === overlay || overlay.contains(event.target as Node)) {
				if ((event.target as HTMLElement).closest('.stop-sync-conflicts-button')) return;
			}
			event.preventDefault();
			event.stopPropagation();
		};
		for (const name of ['mousedown', 'touchstart', 'pointerdown', 'click']) {
			overlay.addEventListener(name, swallow, true);
		}

		const card = overlay.createDiv({ cls: 'stop-sync-conflicts-card' });

		const heading = card.createDiv({ cls: 'stop-sync-conflicts-heading' });
		const spinner = heading.createSpan({ cls: 'stop-sync-conflicts-spinner' });
		setIcon(spinner, 'refresh-cw');
		heading.createSpan({ cls: 'stop-sync-conflicts-title', text: 'Waiting for sync' });

		this.detailEl = card.createDiv({
			cls: 'stop-sync-conflicts-detail',
			text: options.detail,
		});
		this.countdownEl = card.createDiv({ cls: 'stop-sync-conflicts-countdown' });

		// Deliberately a plain button: this is an escape hatch, not the
		// recommended action, and a red button would read as destructive.
		const button = card.createEl('button', {
			cls: 'stop-sync-conflicts-button',
			text: 'Edit anyway',
		});
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			options.onEditAnyway();
		});
	}
}
