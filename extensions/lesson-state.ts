/**
 * lesson-state — durable, machine-readable progress tracking for lessons.
 *
 * The lesson log (mdlog) is the learner's artifact; this is the teacher's.
 * Each lesson owns a folder — `lessons/<topic-slug>/` with `lesson.md`,
 * `state.json`, and `assets/` — and state.json records topic, goal, the
 * planned DAG, and per-node verification status with quiz attempt history.
 * A fresh agent session finds it with `lesson_state` (action "list"), opens
 * it, and picks up exactly where the last session stopped — see the
 * "Resuming a lesson" section of the teach skill. Legacy flat-layout
 * lessons (`lessons/<slug>.state.json` + sibling .md) are migrated into
 * folders whenever they are encountered.
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

interface Gap {
	id: string;
	text: string;
	at: string;
	status: "open" | "covered";
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
	gaps: Gap[];
}

const NODE_STATUSES = ["prior", "pending", "verified"] as ["prior", "pending", "verified"];

const Params = Type.Object({
	action: StringEnum(["open", "plan", "mark", "gap", "status", "list", "complete"] as [string, ...string[]], {
		description: [
			"open: create a lesson state file (topic+goal) or load an existing one (path) and make it current.",
			"plan: commit the full node DAG.",
			"mark: set one node's status.",
			"gap: record something the learner flagged as not knowing (text), or mark a gap covered (gap id).",
			"status: read the current lesson's full state.",
			"list: find every lesson state under lessons/ with progress.",
			"complete: mark the current lesson finished.",
		].join(" "),
	}),
	topic: Type.Optional(Type.String({ description: "open: lesson topic" })),
	goal: Type.Optional(Type.String({ description: "open: one-sentence goal understanding" })),
	log: Type.Optional(
		Type.String({
			description: "open: markdown lesson log path (lessons/<topic-slug>/lesson.md) — state.json is stored in the same folder",
		}),
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
	text: Type.Optional(Type.String({ description: "gap: what the learner doesn't know, in their words" })),
	gap: Type.Optional(Type.String({ description: "gap: id of a gap to mark covered" })),
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
		const state = JSON.parse(raw) as LessonState;
		if (!Array.isArray(state.gaps)) state.gaps = [];
		return state;
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
	const open = state.gaps.filter((g) => g.status === "open").length;
	const gapNote = open > 0 ? `, ${open} open gap${open === 1 ? "" : "s"}` : "";
	return `${state.topic} — ${verified}/${teachable.length} verified${next ? `, next: ${next.id}` : ""}${gapNote}`;
}

function addGap(state: LessonState, text: string): Gap {
	const gap: Gap = {
		id: `g${state.gaps.length + 1}`,
		text,
		at: new Date().toISOString(),
		status: "open",
	};
	state.gaps.push(gap);
	return gap;
}

/** Where a legacy flat state path (`lessons/<slug>.state.json`) lives after migration. */
export function legacyAlt(p: string): string | null {
	if (!p.endsWith(".state.json")) return null;
	return path.join(path.dirname(p), path.basename(p, ".state.json"), "state.json");
}

/**
 * Migrate legacy flat-layout lessons into per-lesson folders:
 * lessons/<slug>.state.json (+ sibling .md log and shared lessons/assets/)
 * → lessons/<slug>/{state.json, lesson.md, assets/}. Returns the moves made.
 */
export function migrateLegacyLessons(cwd: string): { from: string; to: string }[] {
	const dir = path.join(cwd, "lessons");
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const moves: { from: string; to: string }[] = [];
	for (const f of entries.filter((f) => f.endsWith(".state.json"))) {
		const from = path.join(dir, f);
		const folder = path.join(dir, path.basename(f, ".state.json"));
		const to = path.join(folder, "state.json");
		try {
			const state = loadState(from);
			fs.mkdirSync(path.join(folder, "assets"), { recursive: true });
			const oldLog = state.log
				? path.isAbsolute(state.log)
					? state.log
					: path.join(cwd, state.log)
				: undefined;
			if (oldLog && path.dirname(oldLog) === dir && fs.existsSync(oldLog)) {
				// carry the diagrams the log references from the shared assets/ dir
				const md = fs.readFileSync(oldLog, "utf8");
				for (const m of md.matchAll(/\bassets\/([A-Za-z0-9._-]+)/g)) {
					const asset = path.join(dir, "assets", m[1]);
					if (fs.existsSync(asset)) fs.renameSync(asset, path.join(folder, "assets", m[1]));
				}
				const newLog = path.join(folder, "lesson.md");
				fs.renameSync(oldLog, newLog);
				state.log = newLog;
			}
			saveState(to, state);
			fs.rmSync(from);
			moves.push({ from, to });
		} catch {
			// unreadable/partial lesson — leave it untouched
		}
	}
	try {
		fs.rmdirSync(path.join(dir, "assets")); // only removes it if now empty
	} catch {}
	return moves;
}

function scanLessons(cwd: string): { file: string; state: LessonState }[] {
	migrateLegacyLessons(cwd);
	const dir = path.join(cwd, "lessons");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: { file: string; state: LessonState }[] = [];
	for (const e of entries.filter((e) => e.isDirectory())) {
		const file = path.join(dir, e.name, "state.json");
		if (!fs.existsSync(file)) continue;
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

	/** After a migration, follow the current lesson's state file to its new home. */
	function syncStatePath() {
		if (!statePath || fs.existsSync(statePath)) return;
		const alt = legacyAlt(statePath);
		if (alt && fs.existsSync(alt)) {
			statePath = alt;
			pi.appendEntry("lesson-state-target", { path: alt });
		}
	}

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
					syncStatePath();
					if (found.length === 0) return ok("No lesson state files under lessons/.");
					const lines = found.map((f) => `${f.file}\n  ${summarize(f.state)} [${f.state.status}] updated ${f.state.updatedAt}`);
					lines.push("Resume one with action 'open' and its path.");
					return ok(lines.join("\n"));
				}

				case "open": {
					let file: string;
					if (params.path) {
						file = path.isAbsolute(params.path) ? params.path : path.join(ctx.cwd, params.path);
						// legacy flat path → migrate everything, then follow the file to its folder
						if (/[^/\\]\.state\.json$/.test(file) && !fs.existsSync(file)) {
							migrateLegacyLessons(ctx.cwd);
							const alt = legacyAlt(file);
							if (alt && fs.existsSync(alt)) file = alt;
						}
					} else if (params.log) {
						const log = path.isAbsolute(params.log) ? params.log : path.join(ctx.cwd, params.log);
						const folder = path.dirname(log);
						if (path.basename(folder) === "lessons") {
							throw new Error(
								"Each lesson lives in its own folder — use lessons/<topic-slug>/lesson.md as the log path",
							);
						}
						file = path.join(folder, "state.json");
					} else if (params.topic) {
						file = path.join(ctx.cwd, "lessons", slugify(params.topic), "state.json");
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
							gaps: [],
						};
						fs.mkdirSync(path.join(path.dirname(file), "assets"), { recursive: true });
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

				case "gap": {
					if (!statePath) throw new Error("No lesson open — call action 'open' first");
					const state = loadState(statePath);
					if (params.gap) {
						const g = state.gaps.find((x) => x.id === params.gap);
						if (!g) {
							const open = state.gaps.filter((x) => x.status === "open").map((x) => x.id);
							throw new Error(`Unknown gap '${params.gap}'. Open gaps: ${open.join(", ") || "none"}`);
						}
						g.status = "covered";
						saveState(statePath, state);
						return ok(`Gap ${g.id} covered: ${g.text}. ${summarize(state)}`, state);
					}
					if (!params.text) throw new Error("gap requires text (to record) or gap (id, to mark covered)");
					const g = addGap(state, params.text);
					saveState(statePath, state);
					return ok(`Gap recorded as ${g.id}: ${g.text}`, state);
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
			syncStatePath();
			if (found.length === 0) {
				ctx.ui.notify("No lessons found under lessons/", "info");
				return;
			}
			ctx.ui.notify(found.map((f) => summarize(f.state)).join("\n"), "info");
		},
	});

	pi.registerCommand("gap", {
		description: "Flag something you don't know so the lesson covers it (/gap <what>; bare /gap lists open gaps)",
		handler: async (args, ctx) => {
			if (!statePath) {
				ctx.ui.notify("No lesson open — start one with /teach or pick one up with /resume", "info");
				return;
			}
			const state = loadState(statePath);
			const text = args.trim();
			if (!text) {
				const open = state.gaps.filter((g) => g.status === "open");
				ctx.ui.notify(
					open.length === 0 ? "No open gaps" : open.map((g) => `${g.id}: ${g.text}`).join("\n"),
					"info",
				);
				return;
			}
			const g = addGap(state, text);
			saveState(statePath, state);
			ctx.ui.notify(`Gap ${g.id} noted: ${text} — the teacher will fold it in at the next checkpoint`, "info");
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
