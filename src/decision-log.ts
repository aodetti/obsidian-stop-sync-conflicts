/**
 * A small in-memory record of what the plugin decided and why.
 *
 * This exists instead of console logging because the console is not reachable
 * on mobile, which is exactly where "why was my note held?" is hardest to
 * answer. The buffer is capped and never leaves the device unless the user
 * copies it themselves.
 */

const CAPACITY = 200;

export interface LogEntry {
	timestamp: number;
	message: string;
}

export class DecisionLog {
	private readonly entries: LogEntry[] = [];

	add(message: string): void {
		this.entries.push({ timestamp: Date.now(), message });
		if (this.entries.length > CAPACITY) {
			this.entries.splice(0, this.entries.length - CAPACITY);
		}
	}

	/** Most recent first, so the interesting line is at the top. */
	recent(limit = 25): LogEntry[] {
		return this.entries.slice(-limit).reverse();
	}

	isEmpty(): boolean {
		return this.entries.length === 0;
	}

	clear(): void {
		this.entries.length = 0;
	}

	toText(): string {
		return this.entries
			.map((entry) => `${formatTime(entry.timestamp)}  ${entry.message}`)
			.join('\n');
	}
}

export function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
