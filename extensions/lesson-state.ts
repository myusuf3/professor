/**
 * lesson-state — durable, machine-readable progress tracking for lessons.
 *
 * The lesson log (mdlog) is the learner's artifact; this is the teacher's:
 * a JSON sidecar next to the log (`lessons/<topic>.state.json`) recording
 * topic, goal, the planned DAG, and per-node verification status with quiz
 * attempt history. A fresh agent session finds it with `lesson_state`
 * (action "list"), opens it, and picks up exactly where the last session
 * stopped — see the "Resuming a lesson" section of the teach skill.
 *
 * Quiz results are captured automatically: answers whose question id
 * matches a plan node id are appended to that node's attempt history, and
 * a correct answer marks a pending node verified. Progress survives even
 * if the model never updates state explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type NodeStatus = "prior" | "pending" | "verified";

interface Attempt {
	at: string;
	correct: boolean;
	idk: boolean;
	note?: string;
}

interface LessonNode {
	id: string;
	title: string;
	deps: string[];
	status: NodeStatus;
	attempts: Attempt[];
}

interface LessonState {
	version: 1;
	topic: string;
	goal: string;
	log?: string;
	status: "active" | "complete";
	createdAt: string;
	updatedAt: string;
	nodes: LessonNode[];
}

const NODE_STATUSES = ["prior", "pending", "verified"] as ["prior", "pending", "verified"];

const Params = Type.Object({
	action: StringEnum(["open", "plan", "mark", "status", "list", "complete"] as [string, ...string[]], {
		description: [
			"open: create a lesson state file (topic+goal) or load an existing one (path) and make it current.",
			"plan: commit the full node DAG.",
			"mark: set one node's status.",
			"status: read the current lesson's full state.",
			"list: find every lesson state under lessons/ with progress.",
			"complete: mark the current lesson finished.",
		].join(" "),
	}),
	topic: Type.Optional(Type.String({ description: "open: lesson topic" })),
	goal: Type.Optional(Type.String({ description: "open: one-sentence goal understanding" })),
	log: Type.Optional(
		Type.String({ description: "open: markdown lesson log path — the state file is stored alongside it" }),
	),
	path: Type.Optional(
		Type.String({ description: "open: explicit state file path (e.g. from a previous 'list') to resume" }),
	),
	nodes: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({
					description: "Node id — MUST be reused as the quiz question id when verifying this node",
				}),
				title: Type.String({ description: "Short human-readable concept name" }),
				deps: Type.Optional(Type.Array(Type.String(), { description: "Ids of prerequisite nodes" })),
				status: Type.Optional(
					StringEnum(NODE_STATUSES, { description: "prior = already mastered per the probe (default: pending)" }),
				),
			}),
			{ description: "plan: the full dependency-ordered node list (replaces any previous plan)" },
		),
	),
	node: Type.Optional(Type.String({ description: "mark: node id" })),
	nodeStatus: Type.Optional(StringEnum(NODE_STATUSES, { description: "mark: new status" })),
});

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function loadState(file: string): LessonState {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		throw new Error(`lesson_state: cannot read ${file}: ${err}`);
	}
	try {
		return JSON.parse(raw) as LessonState;
	} catch (err) {
		throw new Error(`lesson_state: ${file} is not valid JSON: ${err}`);
	}
}

function saveState(file: string, state: LessonState) {
	state.updatedAt = new Date().toISOString();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
}

/** First pending node whose prerequisites are all satisfied. */
function nextNode(state: LessonState): LessonNode | undefined {
	return state.nodes.find(
		(n) =>
			n.status === "pending" &&
			n.deps.every((d) => state.nodes.find((x) => x.id === d)?.status !== "pending"),
	);
}

function summarize(state: LessonState): string {
	const teachable = state.nodes.filter((n) => n.status !== "prior");
	const verified = teachable.filter((n) => n.status === "verified").length;
	if (state.status === "complete") return `${state.topic} — complete (${verified}/${teachable.length})`;
	if (teachable.length === 0) return `${state.topic} — no plan committed yet`;
	const next = nextNode(state);
	return `${state.topic} — ${verified}/${teachable.length} verified${next ? `, next: ${next.id}` : ""}`;
}

function scanLessons(cwd: string): { file: string; state: LessonState }[] {
	const dir = path.join(cwd, "lessons");
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const found: { file: string; state: LessonState }[] = [];
	for (const f of entries.filter((f) => f.endsWith(".state.json"))) {
		const file = path.join(dir, f);
		try {
			found.push({ file, state: loadState(file) });
		} catch {
			// unreadable state file — skip rather than break listing
		}
	}
	return found.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}

interface QuizResultDetails {
	questions: { id: string }[];
	answers: { id: string; correct: boolean; idk: boolean; note?: string }[];
	cancelled: boolean;
}

export default function lessonState(pi: ExtensionAPI) {
	let statePath: string | null = null;

	function reconstruct(ctx: { sessionManager: { getBranch(): unknown[] } }) {
		statePath = null;
		for (const entry of ctx.sessionManager.getBranch() as {
			type: string;
			customType?: string;
			data?: { path?: string };
		}[]) {
			if (entry.type === "custom" && entry.customType === "lesson-state-target" && entry.data !== undefined) {
				statePath = entry.data.path ?? null;
			}
		}
	}

	pi.registerTool({
		name: "lesson_state",
		label: "Lesson state",
		description: [
			"Durable lesson progress: topic, goal, the planned concept DAG, and per-node verification status,",
			"stored as JSON next to the lesson log so any future session can resume the lesson exactly where it stopped.",
			"Open (or resume) a lesson, commit the plan as nodes, and statuses update automatically from quiz results",
			"whose question ids match node ids. Use 'list' to discover resumable lessons, 'status' to read progress.",
		].join(" "),
		promptSnippet: "Durable lesson progress tracking (plan DAG + per-node verification) for cross-session resume",
		parameters: Params,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const ok = (text: string, state?: LessonState) => ({
				content: [{ type: "text" as const, text }],
				details: { path: statePath, summary: state ? summarize(state) : undefined },
			});

			switch (params.action) {
				case "list": {
					const found = scanLessons(ctx.cwd);
					if (found.length === 0) return ok("No lesson state files under lessons/.");
					const lines = found.map((f) => `${f.file}\n  ${summarize(f.state)} [${f.state.status}] updated ${f.state.updatedAt}`);
					lines.push("Resume one with action 'open' and its path.");
					return ok(lines.join("\n"));
				}

				case "open": {
					let file: string;
					if (params.path) {
						file = path.isAbsolute(params.path) ? params.path : path.join(ctx.cwd, params.path);
					} else if (params.log) {
						const log = path.isAbsolute(params.log) ? params.log : path.join(ctx.cwd, params.log);
						file = log.replace(/\.md$/, "") + ".state.json";
					} else if (params.topic) {
						file = path.join(ctx.cwd, "lessons", `${slugify(params.topic)}.state.json`);
					} else {
						throw new Error("open requires topic (new lesson), log, or path (resume)");
					}

					let state: LessonState;
					if (fs.existsSync(file)) {
						state = loadState(file);
						if (params.log) state.log = params.log;
					} else {
						if (!params.topic || !params.goal) {
							throw new Error(`No state at ${file} — creating a new lesson requires topic and goal`);
						}
						state = {
							version: 1,
							topic: params.topic,
							goal: params.goal,
							log: params.log,
							status: "active",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							nodes: [],
						};
					}
					saveState(file, state);
					statePath = file;
					pi.appendEntry("lesson-state-target", { path: file });
					return ok(`Lesson state: ${file}\n${JSON.stringify(state, null, 2)}`, state);
				}

				case "plan": {
					if (!statePath) throw new Error("No lesson open — call action 'open' first");
					if (!params.nodes?.length) throw new Error("plan requires a non-empty nodes array");
					const ids = new Set<string>();
					for (const n of params.nodes) {
						if (ids.has(n.id)) throw new Error(`Duplicate node id '${n.id}'`);
						ids.add(n.id);
					}
					for (const n of params.nodes) {
						for (const d of n.deps ?? []) {
							if (!ids.has(d)) throw new Error(`Node '${n.id}' depends on unknown node '${d}'`);
						}
					}
					const state = loadState(statePath);
					const old = new Map(state.nodes.map((n) => [n.id, n]));
					state.nodes = params.nodes.map((n) => ({
						id: n.id,
						title: n.title,
						deps: n.deps ?? [],
						status: (n.status as NodeStatus | undefined) ?? "pending",
						attempts: old.get(n.id)?.attempts ?? [],
					}));
					saveState(statePath, state);
					return ok(`Plan committed: ${summarize(state)}`, state);
				}

				case "mark": {
					if (!statePath) throw new Error("No lesson open — call action 'open' first");
					if (!params.node || !params.nodeStatus) throw new Error("mark requires node and nodeStatus");
					const state = loadState(statePath);
					const node = state.nodes.find((n) => n.id === params.node);
					if (!node) {
						throw new Error(`Unknown node '${params.node}'. Known: ${state.nodes.map((n) => n.id).join(", ")}`);
					}
					node.status = params.nodeStatus as NodeStatus;
					saveState(statePath, state);
					return ok(`${node.id} → ${node.status}. ${summarize(state)}`, state);
				}

				case "status": {
					if (!statePath) throw new Error("No lesson open — call action 'open' first (or 'list' to find one)");
					const state = loadState(statePath);
					return ok(JSON.stringify(state, null, 2), state);
				}

				case "complete": {
					if (!statePath) throw new Error("No lesson open");
					const state = loadState(statePath);
					state.status = "complete";
					saveState(statePath, state);
					return ok(`Lesson complete: ${summarize(state)}`, state);
				}

				default:
					throw new Error(`Unknown action '${params.action}'`);
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("lesson_state ")) + theme.fg("muted", String(args.action ?? "?")),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { summary?: string } | undefined;
			if (details?.summary) return new Text(theme.fg("success", `◈ ${details.summary}`), 0, 0);
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerCommand("lessons", {
		description: "List lessons and their progress",
		handler: async (_args, ctx) => {
			const found = scanLessons(ctx.cwd);
			if (found.length === 0) {
				ctx.ui.notify("No lessons found under lessons/", "info");
				return;
			}
			ctx.ui.notify(found.map((f) => summarize(f.state)).join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

	// Auto-capture quiz evidence: question id == node id → attempt history,
	// and a correct answer promotes a pending node to verified.
	pi.on("tool_execution_end", (event) => {
		if (!statePath || event.toolName !== "quiz" || event.isError) return;
		const details = (event.result as { details?: QuizResultDetails } | undefined)?.details;
		if (!details || details.cancelled || details.answers.length === 0) return;
		let state: LessonState;
		try {
			state = loadState(statePath);
		} catch {
			return;
		}
		let touched = false;
		for (const a of details.answers) {
			const node = state.nodes.find((n) => n.id === a.id);
			if (!node) continue;
			node.attempts.push({ at: new Date().toISOString(), correct: a.correct, idk: a.idk, note: a.note });
			if (a.correct && node.status === "pending") node.status = "verified";
			touched = true;
		}
		if (touched) saveState(statePath, state);
	});
}
