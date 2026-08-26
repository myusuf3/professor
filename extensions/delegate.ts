/**
 * delegate — run professor's subagents (researcher, svg-artist) as
 * isolated child `pi` processes.
 *
 * Agent definitions ship with this package in ../agents/*.md
 * (YAML frontmatter: name, description, tools, model; body = system prompt).
 * Children run in JSON mode; their NDJSON event stream is parsed to
 * stream progress into the parent tool row.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL = 4;
const OUTPUT_CAP = 50 * 1024;

// Extension-provided tools live in files the child pi process must load
// explicitly with -e. An agent whose frontmatter `tools:` names one of these
// gets the owning extension file injected (lib/, so the teacher's own session
// never loads them).
const SVG_TOOLS_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"lib",
	"visual-tools",
	"svg-tools.ts",
);
const TOOL_EXTENSIONS: Record<string, string> = {
	write_svg: SVG_TOOLS_PATH,
	edit_svg: SVG_TOOLS_PATH,
	render_svg: SVG_TOOLS_PATH,
};

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

interface TaskResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number | null; // null while running
	stderr: string;
	turns: number;
	cost: number;
}

interface DelegateDetails {
	results: TaskResult[];
}

type AgentFrontmatter = Record<string, unknown> & {
	name?: string;
	description?: string;
	tools?: string | string[];
	model?: string;
};

function loadAgents(): AgentConfig[] {
	const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
	if (!fs.existsSync(agentsDir)) return [];
	return fs
		.readdirSync(agentsDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const raw = fs.readFileSync(path.join(agentsDir, f), "utf8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw);
			const tools =
				typeof frontmatter.tools === "string"
					? frontmatter.tools.split(/[\s,]+/).filter(Boolean)
					: frontmatter.tools;
			return {
				name: frontmatter.name ?? path.basename(f, ".md"),
				description: frontmatter.description ?? "",
				tools,
				model: frontmatter.model,
				systemPrompt: body.trim(),
			};
		});
}

async function runAgent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	defaults: { model?: string; thinkingLevel?: string },
	signal: AbortSignal | undefined,
	result: TaskResult,
	onProgress: () => void,
): Promise<void> {
	const args = ["--mode", "json", "-p", "--no-session"];
	const model = agent.model ?? defaults.model;
	if (model) args.push("--model", model);
	if (!agent.model && defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
	if (agent.tools?.length) {
		args.push("--tools", agent.tools.join(","));
		const extPaths = new Set(
			agent.tools.map((t) => TOOL_EXTENSIONS[t]).filter((p): p is string => p !== undefined),
		);
		for (const extPath of extPaths) args.push("-e", extPath);
	}

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "professor-"));
	const promptPath = path.join(tmpDir, "prompt.md");
	await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	args.push("--append-system-prompt", promptPath);
	args.push(`Task: ${task}`);

	let wasAborted = false;
	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } } } };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					result.turns++;
					result.cost += event.message.usage?.cost?.total ?? 0;
					const content = event.message.content;
					if (Array.isArray(content)) {
						const text = content
							.filter((b): b is { type: "text"; text: string } => b?.type === "text")
							.map((b) => b.text)
							.join("\n");
						if (text.trim()) result.output = text.slice(0, OUTPUT_CAP);
					}
					onProgress();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent aborted");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

export default function delegate(pi: ExtensionAPI) {
	const agents = loadAgents();
	const agentNames = agents.map((a) => a.name);
	if (agentNames.length === 0) return;

	const TaskItem = Type.Object({
		agent: StringEnum(agentNames as [string, ...string[]], { description: "Agent to run" }),
		task: Type.String({ description: "Self-contained task description for the agent" }),
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to a specialized subagent with its own isolated context.",
			`Available agents: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}.`,
			"Single mode: {agent, task}. Parallel mode: {tasks: [{agent, task}, ...]} — use parallel for independent fact-checks.",
			"Tasks must be self-contained: the agent sees nothing of this conversation.",
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(StringEnum(agentNames as [string, ...string[]], { description: "Agent (single mode)" })),
			task: Type.Optional(Type.String({ description: "Task (single mode)" })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			const items: { agent: string; task: string }[] = params.tasks?.length
				? params.tasks
				: params.agent && params.task
					? [{ agent: params.agent, task: params.task }]
					: [];
			if (items.length === 0) throw new Error("Provide {agent, task} or {tasks: [...]}");

			const defaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const results: TaskResult[] = items.map((item) => ({
				agent: item.agent,
				task: item.task,
				output: "",
				exitCode: null,
				stderr: "",
				turns: 0,
				cost: 0,
			}));
			const emit = () =>
				onUpdate?.({
					content: [{ type: "text", text: "(running...)" }],
					details: { results } satisfies DelegateDetails,
				});

			let next = 0;
			const workers = Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, async () => {
				while (next < items.length) {
					const i = next++;
					const agent = agents.find((a) => a.name === items[i].agent)!;
					await runAgent(agent, items[i].task, ctx.cwd, defaults, signal, results[i], emit);
				}
			});
			await Promise.all(workers);

			const failed = results.filter((r) => r.exitCode !== 0);
			if (failed.length === results.length) {
				throw new Error(
					`All subagents failed: ${failed.map((r) => `${r.agent}: ${r.stderr.slice(-500) || "no output"}`).join("; ")}`,
				);
			}

			const text = results
				.map((r) => {
					const header = results.length > 1 ? `## ${r.agent}: ${r.task.slice(0, 80)}\n\n` : "";
					const body = r.exitCode === 0 ? r.output || "(no output)" : `FAILED: ${r.stderr.slice(-500)}`;
					return header + body;
				})
				.join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { results } satisfies DelegateDetails,
			};
		},

		renderCall(args, theme) {
			const items = (args.tasks as { agent: string }[]) ?? (args.agent ? [{ agent: args.agent as string }] : []);
			const byAgent = items.map((t) => t.agent).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("muted", byAgent || "?"),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as DelegateDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const container = new Container();
			for (const r of details.results) {
				const status =
					r.exitCode === null
						? theme.fg("warning", "● running")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
				container.addChild(
					new Text(`${status} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `${r.turns} turns, $${r.cost.toFixed(3)}`)}`, 0, 0),
				);
				if (options.expanded && r.output) {
					container.addChild(new Markdown(r.output, 2, 0, getMarkdownTheme()));
				}
			}
			return container;
		},
	});
}
