/**
 * Minimal Chrome DevTools Protocol client, no dependencies.
 *
 * Obsidian is an Electron app, so launching it with --remote-debugging-port
 * lets us evaluate code inside the real renderer and, more importantly, send
 * genuine trusted input events. Synthetic DOM events would not prove that
 * typing is really blocked; Input.dispatchKeyEvent does.
 */

const DEVTOOLS_ORIGIN = 'http://127.0.0.1:9222';

export async function findRendererTarget({ attempts = 40, delayMs = 500 } = {}) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await fetch(`${DEVTOOLS_ORIGIN}/json/list`);
			const targets = await response.json();
			const page = targets.find(
				(target) =>
					target.type === 'page' &&
					typeof target.url === 'string' &&
					target.url.includes('app://obsidian.md'),
			);
			if (page?.webSocketDebuggerUrl) return page;
		} catch {
			/* the app is still starting up */
		}
		await sleep(delayMs);
	}
	throw new Error('Could not find the Obsidian renderer on port 9222.');
}

export class CdpSession {
	#socket;
	#nextId = 1;
	#pending = new Map();

	static async connect(webSocketDebuggerUrl) {
		const session = new CdpSession();
		await session.#open(webSocketDebuggerUrl);
		await session.send('Runtime.enable');
		return session;
	}

	#open(url) {
		return new Promise((resolve, reject) => {
			this.#socket = new WebSocket(url);
			this.#socket.addEventListener('open', () => resolve());
			this.#socket.addEventListener('error', () =>
				reject(new Error(`WebSocket failed: ${url}`)),
			);
			this.#socket.addEventListener('message', (event) => {
				const message = JSON.parse(event.data);
				const pending = this.#pending.get(message.id);
				if (!pending) return;
				this.#pending.delete(message.id);
				if (message.error) {
					pending.reject(new Error(message.error.message));
				} else {
					pending.resolve(message.result);
				}
			});
		});
	}

	send(method, params = {}) {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Evaluates an expression in the page and returns its value. */
	async evaluate(expression) {
		const result = await this.send('Runtime.evaluate', {
			expression: `(async () => { ${expression} })()`,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (result.exceptionDetails) {
			const detail =
				result.exceptionDetails.exception?.description ??
				result.exceptionDetails.text;
			throw new Error(`Evaluation failed: ${detail}`);
		}
		return result.result.value;
	}

	/** Types text as real trusted input into whatever currently has focus. */
	async typeText(text) {
		for (const character of text) {
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyDown',
				text: character,
				unmodifiedText: character,
				key: character,
			});
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key: character,
			});
		}
	}

	/** Presses a named key, e.g. Backspace or Enter. */
	async pressKey(key, windowsVirtualKeyCode) {
		await this.send('Input.dispatchKeyEvent', {
			type: 'rawKeyDown',
			key,
			windowsVirtualKeyCode,
			nativeVirtualKeyCode: windowsVirtualKeyCode,
		});
		await this.send('Input.dispatchKeyEvent', {
			type: 'keyUp',
			key,
			windowsVirtualKeyCode,
			nativeVirtualKeyCode: windowsVirtualKeyCode,
		});
	}

	close() {
		this.#socket?.close();
	}
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
