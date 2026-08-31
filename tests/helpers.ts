/**
 * Shared test harness: a minimal mock of the pi ExtensionCore that extensions
 * are handed at instantiation. It captures the tools, commands, and event
 * handlers each extension registers, so tests can invoke the real extension
 * logic against temp directories.
 */

export interface ToolCtx {
	cwd: string;
	ui: { setStatus(key: string, text?: string): void; notify(msg: string, level?: string): void };
	sessionManager: { getBranch(): unknown[] };
}

export interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: ToolCtx) => Promise<{
		content: { type: "text"; text: string }[];
		details?: Record<string, unknown>;
	}>;
	renderCall?: (...a: unknown[]) => unknown;
	renderResult?: (...a: unknown[]) => unknown;
}

export interface MockPi {
	pi: {
		registerTool(tool: RegisteredTool): void;
		registerCommand(name: string, def: Record<string, unknown>): void;
		registerMarkdownTransformer(fn: (md: string) => string): void;
		on(event: string, handler: (...args: unknown[]) => unknown): void;
		appendEntry(type: string, data: unknown): void;
	};
	tools: Map<string, RegisteredTool>;
	commands: Map<string, Record<string, unknown>>;
	handlers: Map<string, (...args: unknown[]) => unknown>;
	entries: { type: string; data: unknown }[];
	markdownTransformers: ((md: string) => string)[];
}

export function createMockPi(): MockPi {
	const mock: MockPi = {
		pi: {
			registerTool(tool) {
				mock.tools.set(tool.name, tool);
			},
			registerCommand(name, def) {
				mock.commands.set(name, def);
			},
			registerMarkdownTransformer(fn) {
				mock.markdownTransformers.push(fn);
			},
			on(event, handler) {
				mock.handlers.set(event, handler);
			},
			appendEntry(type, data) {
				mock.entries.push({ type, data });
			},
		},
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		entries: [],
		markdownTransformers: [],
	};
	return mock;
}

/** A functioning `ctx` for tool execution against a temp cwd. */
export function makeCtx(cwd: string): ToolCtx {
	return {
		cwd,
		ui: {
			setStatus: () => {},
			notify: () => {},
		},
		sessionManager: { getBranch: () => [] },
	};
}

/** Today as the ISO date string the header/log uses. */
export function todaysDateString(): string {
	return new Date().toISOString().slice(0, 10);
}
