/**
 * Shared UI mutex: ctx.ui.custom()/editor handles one active call at a time,
 * so all pop-up tools (quiz, ask_user_question) must serialize against each
 * other, not just against themselves. Stashed on globalThis so it stays a
 * single lock even if this module is instantiated more than once.
 */

interface UiLock {
	withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}

const KEY = "__professorUiLock";

function getLock(): UiLock {
	const g = globalThis as Record<string, unknown>;
	if (!g[KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release!: () => void;
				chain = new Promise<void>((r) => {
					release = r;
				});
				return prev.then(fn).finally(() => release());
			},
		} satisfies UiLock;
	}
	return g[KEY] as UiLock;
}

export function withUiLock<T>(fn: () => T | Promise<T>): Promise<T> {
	return getLock().withLock(fn);
}
