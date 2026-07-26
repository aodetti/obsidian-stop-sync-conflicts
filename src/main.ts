import { MarkdownView, Notice, Plugin, type TFile } from 'obsidian';
import { DecisionLog } from './decision-log';
import { ConflictGuard } from './guard';
import { MockSync, SCENARIOS } from './mock-sync';
import {
	DEFAULT_SETTINGS,
	StopSyncConflictsSettingTab,
	type StopSyncConflictsSettings,
} from './settings';
import { SyncMonitor } from './sync-monitor';

export default class StopSyncConflictsPlugin extends Plugin {
	settings!: StopSyncConflictsSettings;
	readonly activity = new DecisionLog();

	private monitor!: SyncMonitor;
	private guard!: ConflictGuard;
	private activeMock: MockSync | null = null;

	async onload() {
		await this.loadSettings();

		this.monitor = new SyncMonitor(this.app, (message) => this.log(message));
		this.guard = new ConflictGuard(
			this.monitor,
			() => this.settings,
			(message) => this.log(message),
		);

		// Sync's own plugin may load after us, so bind once the layout is ready
		// rather than racing it during startup.
		this.app.workspace.onLayoutReady(() => this.monitor.start());

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.onFileOpen(file)),
		);
		// Switching to a pane that already had the note open doesn't fire
		// `file-open`, but it is still the moment the user starts editing.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file) {
					this.guard.guard(view, view.file);
				}
			}),
		);

		this.addCommand({
			id: 'release-holds',
			name: 'Stop waiting and edit now',
			callback: () => {
				this.guard.releaseAll();
				new Notice('Editing unblocked.');
			},
		});

		this.addCommand({
			id: 'copy-activity',
			name: 'Copy recent activity',
			callback: async () => {
				if (this.activity.isEmpty()) {
					new Notice('No activity recorded yet.');
					return;
				}
				try {
					await navigator.clipboard.writeText(this.activity.toText());
					new Notice('Recent activity copied.');
				} catch {
					new Notice('Could not copy to the clipboard.');
				}
			},
		});

		if (this.settings.devCommands) {
			this.registerScenarioCommands();
		}

		this.addSettingTab(new StopSyncConflictsSettingTab(this.app, this));
	}

	onunload() {
		this.guard?.releaseAll();
		this.monitor?.stop();
		this.activeMock?.dispose();
		this.activeMock = null;
	}

	releaseAllHolds(): void {
		this.guard?.releaseAll();
	}

	private onFileOpen(file: TFile | null): void {
		if (!file) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== file.path) return;
		this.guard.guard(view, file);
	}

	/**
	 * Commands that swap the real sync instance for a scripted fake, so each
	 * branch can be checked without a sync subscription or a second device.
	 */
	private registerScenarioCommands(): void {
		for (const scenario of SCENARIOS) {
			this.addCommand({
				id: `scenario-${scenario.id}`,
				name: `Test: ${scenario.name}`,
				callback: () => {
					const activePath =
						this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ??
						null;

					this.guard.releaseAll();
					this.activeMock?.dispose();
					this.activeMock = null;

					const built = scenario.build(activePath);
					if (built instanceof MockSync) this.activeMock = built;
					this.monitor.setMock(built);

					if (built instanceof MockSync && scenario.then) {
						scenario.then(built, activePath);
					}

					new Notice(`${scenario.name}\n${scenario.expectation}`, 6000);
				},
			});
		}
	}

	private log(message: string): void {
		this.activity.add(message);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<StopSyncConflictsSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
