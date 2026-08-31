/**
 * mdlog — mirror the lesson into a plain markdown file, and render LaTeX
 * as Unicode in the terminal.
 *
 * The file on disk keeps raw LaTeX ($...$ / $$...$$) so any KaTeX-aware
 * viewer (VS Code preview, GitHub) renders it properly; the terminal gets
 * a best-effort Unicode approximation via a display-only transformer.
 *
 * The model links a log file with the `lesson_log` tool (the teach skill
 * tells it to); the user can inspect or override with /log.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { transformMathInMarkdown } from "../lib/math-unicode.ts";

interface QuizDetails {
	questions: { id: string; label: string; prompt: string; options: string[]; correctIndices: number[] }[];
	answers: { id: string; selectedIndices: number[]; correct: boolean; idk: boolean; note?: string }[];
	cancelled: boolean;
}

function extractText(message: { role: string; content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

function formatQuizMarkdown(details: QuizDetails): string {
	const lines: string[] = ["**Quiz**", ""];
	for (const a of details.answers) {
		const q = details.questions.find((qq) => qq.id === a.id);
		if (!q) continue;
		const correctTxt = q.correctIndices.map((c) => q.options[c - 1]).join(", ");
		const selTxt = a.selectedIndices.map((s) => q.options[s - 1]).join(", ");
		if (a.idk) {
			lines.push(`- ❓ ${q.prompt} — *I don't know* (answer: ${correctTxt})`);
		} else if (a.correct) {
			lines.push(`- ✅ ${q.prompt} — ${selTxt}`);
		} else {
			lines.push(`- ❌ ${q.prompt} — answered *${selTxt}*, correct: **${correctTxt}**`);
		}
		if (a.note) lines.push(`  - note: ${a.note}`);
	}
	const score = details.answers.filter((a) => a.correct).length;
	lines.push("", `Score: ${score}/${details.answers.length}`);
	return lines.join("\n");
}

export default function mdlog(pi: ExtensionAPI) {
	let logPath: string | null = null;

	function append(section: string) {
		if (!logPath) return;
		try {
			appendFileSync(logPath, `${section.trimEnd()}\n\n`, "utf8");
		} catch (err) {
			logPath = null;
			throw new Error(`mdlog: failed to write ${logPath}: ${err}`);
		}
	}

	function setLogPath(target: string, cwd: string, title?: string): { path: string; created: boolean } {
		const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
		mkdirSync(path.dirname(resolved), { recursive: true });
		const created = !existsSync(resolved);
		if (created) {
			const heading = title ?? path.basename(resolved, ".md").replace(/[-_]/g, " ");
			appendFileSync(resolved, `# ${heading}\n\n*${new Date().toISOString().slice(0, 10)}*\n\n`, "utf8");
		}
		logPath = resolved;
		pi.appendEntry("mdlog-target", { path: resolved });
		return { path: resolved, created };
	}

	/** Learner-facing form of a user message, or null if nothing loggable remains. */
	function cleanUserText(raw: string): string | null {
		// Injected payloads (loaded skills, system reminders) are not the learner's words
		const text = raw
			.replace(/<(skill|system-reminder|command-name|command-args)>[\s\S]*?<\/\1>/g, "")
			.trim();
		if (!text || text.startsWith("Task:")) return null;
		return text.split("\n").map((l) => `> ${l}`).join("\n");
	}

	/**
	 * Reconstruct the session so far into a freshly created log file, so a
	 * log linked mid-lesson still captures the whole lesson.
	 */
	function backfill(ctx: { sessionManager: { getBranch(): unknown[] } }): number {
		if (!logPath) return 0;
		let count = 0;
		for (const entry of ctx.sessionManager.getBranch() as {
			type: string;
			message?: {
				role: string;
				content: unknown;
				toolName?: string;
				isError?: boolean;
				details?: unknown;
			};
		}[]) {
			if (entry.type !== "message" || !entry.message) continue;
			const msg = entry.message;
			if (msg.role === "user") {
				const text = cleanUserText(extractText(msg as { role: string; content: unknown }));
				if (text) {
					append(text);
					count++;
				}
			} else if (msg.role === "assistant") {
				const text = extractText(msg as { role: string; content: unknown }).trim();
				if (text) {
					append(text);
					count++;
				}
			} else if (msg.role === "toolResult" && msg.toolName === "quiz" && !msg.isError) {
				const details = msg.details as QuizDetails | undefined;
				if (details && !details.cancelled && details.answers.length > 0) {
					append(formatQuizMarkdown(details));
					count++;
				}
			}
		}
		return count;
	}

	function reconstruct(ctx: { sessionManager: { getBranch(): unknown[] } }) {
		logPath = null;
		for (const entry of ctx.sessionManager.getBranch() as {
			type: string;
			customType?: string;
			data?: { path?: string };
		}[]) {
			if (entry.type === "custom" && entry.customType === "mdlog-target" && entry.data?.path) {
				logPath = entry.data.path;
			}
		}
	}

	// Terminal LaTeX → Unicode (display-only; file and session keep raw LaTeX)
	pi.registerMarkdownTransformer((markdown) => transformMathInMarkdown(markdown));

	pi.registerTool({
		name: "lesson_log",
		label: "Lesson log",
		description:
			"Link a markdown file as the lesson log. All subsequent conversation and quiz results are appended to it. Use a per-lesson folder path like 'lessons/differential-forms/lesson.md' — the creation date is stamped into the file's header automatically.",
		parameters: Type.Object({
			path: Type.String({ description: "Markdown file path, relative to the working directory" }),
			title: Type.Optional(Type.String({ description: "Heading written when the file is created" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { path: resolved, created } = setLogPath(params.path, ctx.cwd, params.title);
			const backfilled = created ? backfill(ctx) : 0;
			ctx.ui.setStatus("mdlog", `✎ ${path.basename(path.dirname(resolved))}`);
			return {
				content: [
					{
						type: "text" as const,
						text: `Lesson log: ${resolved}${backfilled ? ` (${backfilled} earlier entries backfilled)` : ""}`,
					},
				],
				details: { path: resolved },
			};
		},
		renderResult(result, _options, theme) {
			const details = result.details as { path?: string } | undefined;
			return new Text(theme.fg("success", `✎ logging to ${details?.path ?? "?"}`), 0, 0);
		},
	});

	pi.registerCommand("log", {
		description: "Show, set, or stop the lesson log file (/log [path|off])",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(logPath ? `Logging to ${logPath}` : "No lesson log linked (/log <path>)", "info");
				return;
			}
			if (arg === "off") {
				logPath = null;
				pi.appendEntry("mdlog-target", { path: null });
				ctx.ui.setStatus("mdlog", undefined);
				ctx.ui.notify("Lesson log unlinked", "info");
				return;
			}
			const { path: resolved, created } = setLogPath(arg, ctx.cwd);
			const backfilled = created ? backfill(ctx) : 0;
			ctx.ui.setStatus("mdlog", `✎ ${path.basename(path.dirname(resolved))}`);
			ctx.ui.notify(`Logging to ${resolved}${backfilled ? ` (${backfilled} entries backfilled)` : ""}`, "info");
		},
	});

	const reconstructAndShow = (ctx: {
		sessionManager: { getBranch(): unknown[] };
		ui: { setStatus(key: string, text: string | undefined): void };
	}) => {
		reconstruct(ctx);
		ctx.ui.setStatus("mdlog", logPath ? `✎ ${path.basename(path.dirname(logPath))}` : undefined);
	};
	pi.on("session_start", (_event, ctx) => reconstructAndShow(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructAndShow(ctx));

	pi.on("message_end", (event) => {
		if (!logPath) return;
		const message = event.message as { role: string; content: unknown };
		if (message.role === "user") {
			const text = cleanUserText(extractText(message));
			if (text) append(text);
		} else if (message.role === "assistant") {
			const text = extractText(message).trim();
			if (text) append(text);
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (!logPath || event.toolName !== "quiz" || event.isError) return;
		const details = (event.result as { details?: QuizDetails } | undefined)?.details;
		if (!details || details.cancelled || details.answers.length === 0) return;
		append(formatQuizMarkdown(details));
	});
}
