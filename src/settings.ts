import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { formatTime } from './decision-log';
import type StopSyncConflictsPlugin from './main';

export interface StopSyncConflictsSettings {
	/** Master switch for the whole behaviour. */
	enabled: boolean;
	/** How long to hold a note before letting the user edit anyway. */
	timeoutSeconds: number;
	/** Hold notes while sync is connected but hasn't reported a finished pass. */
	waitDuringInitialIndex: boolean;
	/** Confirm with a notice once a held note is released. */
	showReadyNotice: boolean;
	/** Warn when sync is in an error state and the note may be stale. */
	warnOnSyncError: boolean;
	/** Register the simulation commands used to test without a sync account. */
	devCommands: boolean;
}

export const DEFAULT_SETTINGS: StopSyncConflictsSettings = {
	enabled: true,
	timeoutSeconds: 10,
	waitDuringInitialIndex: true,
	showReadyNotice: true,
	warnOnSyncError: true,
	devCommands: false,
};

export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 60;

export class StopSyncConflictsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: StopSyncConflictsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Hold notes until they finish syncing')
			.setDesc(
				'When you open a note that has an update waiting, editing is held until the update arrives.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					if (!value) this.plugin.releaseAllHolds();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Give up after')
			.setDesc(
				'If sync has not caught up within this many seconds — for example when you are offline — editing is unblocked with a warning.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, 1)
					.setValue(this.plugin.settings.timeoutSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.timeoutSeconds = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Wait while sync is still checking the server')
			.setDesc(
				'Just after startup, sync has not yet reported which notes changed. Leave this on to wait anyway, which is the safest against conflicts. Turn it off to only wait on a confirmed incoming change.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.waitDuringInitialIndex)
					.onChange(async (value) => {
						this.plugin.settings.waitDuringInitialIndex = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Confirm when a note is released')
			.setDesc('Show a brief notice once a held note is up to date.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showReadyNotice)
					.onChange(async (value) => {
						this.plugin.settings.showReadyNotice = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Warn when sync has an error')
			.setDesc(
				'Sync errors cannot be waited out, so editing is allowed immediately with a warning that the note may be out of date.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.warnOnSyncError)
					.onChange(async (value) => {
						this.plugin.settings.warnOnSyncError = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Troubleshooting').setHeading();

		new Setting(containerEl)
			.setName('Simulation commands')
			.setDesc(
				'Adds commands that fake sync states — downloading, offline, paused — so you can check the behaviour without a second device. Reload the plugin after changing this.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.devCommands)
					.onChange(async (value) => {
						this.plugin.settings.devCommands = value;
						await this.plugin.saveSettings();
					}),
			);

		this.displayActivity(containerEl);
	}

	/**
	 * Shows why recent notes were held or allowed. Rendered here rather than
	 * logged, so it is readable on mobile too.
	 */
	private displayActivity(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Recent activity')
			.setDesc('The most recent decisions this plugin made.')
			.addButton((button) =>
				button.setButtonText('Copy').onClick(async () => {
					if (this.plugin.activity.isEmpty()) {
						new Notice('No activity recorded yet.');
						return;
					}
					try {
						await navigator.clipboard.writeText(this.plugin.activity.toText());
						new Notice('Recent activity copied.');
					} catch {
						new Notice('Could not copy to the clipboard.');
					}
				}),
			)
			.addExtraButton((button) =>
				button
					.setIcon('rotate-ccw')
					.setTooltip('Refresh')
					.onClick(() => this.display()),
			);

		const list = containerEl.createDiv({ cls: 'stop-sync-conflicts-activity' });
		const entries = this.plugin.activity.recent();

		if (entries.length === 0) {
			list.createDiv({
				cls: 'stop-sync-conflicts-activity-empty',
				text: 'Nothing recorded yet. Open a note to see decisions here.',
			});
			return;
		}

		for (const entry of entries) {
			const row = list.createDiv({ cls: 'stop-sync-conflicts-activity-row' });
			row.createSpan({
				cls: 'stop-sync-conflicts-activity-time',
				text: formatTime(entry.timestamp),
			});
			row.createSpan({
				cls: 'stop-sync-conflicts-activity-message',
				text: entry.message,
			});
		}
	}
}
