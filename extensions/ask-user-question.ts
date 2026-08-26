/**
 * ask_user_question — structured, UNGRADED input from the learner.
 *
 * The other half of quiz: quiz measures understanding, this gathers goals,
 * preferences, and decisions (single-select, multi-select, or free text).
 * Options always grow an "Other" entry with an inline editor, so a picker
 * never boxes the learner in.
 *
 * Ported from amosblomqvist/learn with thanks; adapted to this package's
 * pi fork and shared UI lock.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withUiLock } from "../lib/ui-lock.ts";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskStatus = "answered" | "cancelled" | "unavailable";
type AskMode = "text" | "single-select" | "multi-select";

interface AskResultDetails {
	status: AskStatus;
	question: string;
	context?: string;
	mode: AskMode;
	answers: AskAnswer[];
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the learner. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Learners can always choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow multiple answers to be selected." }),
	),
});

function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildDetails(
	status: AskStatus,
	question: string,
	mode: AskMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
): AskResultDetails {
	return { status, question, context, mode, answers, message };
}

function cancelledResult(question: string, mode: AskMode, context?: string) {
	const message = "Learner cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildDetails("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildDetails("unavailable", question, mode, [], context, message),
	};
}

function buildResult(question: string, context: string | undefined, mode: AskMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `Learner answered: ${answer.label}` : "Learner submitted an empty response";
	} else if (mode === "single-select") {
		text = `Learner selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `Learner selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: buildDetails("answered", question, mode, answers, context),
	};
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: AskAnswer | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			done({ type: "other", label: trimmed, value: trimmed });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			// Digit shortcut selects that option directly (matches quiz UX)
			if (/^[1-9]$/.test(data)) {
				const idx = Number(data) - 1;
				if (idx < options.length) {
					const o = allOptions[idx];
					done({ type: "option", label: o.label, value: o.value, index: o.index! });
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				done({ type: "option", label: selected.label, value: selected.value, index: selected.index! });
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// Cache MUST be width-keyed: pi-tui calls requestRender() but not
			// invalidate() on resize; stale wider lines crash the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to go back"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓/digits select • Enter confirm • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const otherLabel = getOtherLabel(options);
	const allItems: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		{ id: "submit", label: "Submit", value: "__submit__", isSubmit: true },
	];

	return ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: (result: AskAnswer[] | null) => void) => {
			let optionIndex = 0;
			let editMode = false;
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;
			const selected = new Map<string, AskAnswer>();
			const editor = new Editor(tui, createEditorTheme(theme));

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (!trimmed) return;
				selected.set("other", { type: "other", label: trimmed, value: trimmed });
				editMode = false;
				refresh();
			};

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function toggleOption(item: DisplayOption) {
				if (selected.has(item.id)) {
					selected.delete(item.id);
				} else {
					selected.set(item.id, { type: "option", label: item.label, value: item.value, index: item.index! });
				}
				refresh();
			}

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText(selected.get("other")?.label || "");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
					refresh();
					return;
				}
				// Digit shortcut toggles that option
				if (/^[1-9]$/.test(data)) {
					const idx = Number(data) - 1;
					if (idx < options.length) toggleOption(allItems[idx]);
					return;
				}

				const current = allItems[optionIndex];
				if (matchesKey(data, Key.space)) {
					if (current.isSubmit) return;
					if (current.isOther) {
						if (selected.has("other")) {
							selected.delete("other");
							refresh();
						} else {
							editMode = true;
							editor.setText("");
							refresh();
						}
						return;
					}
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (current.isSubmit) {
						if (selected.size > 0) {
							done(sortAnswers(Array.from(selected.values())));
						}
						return;
					}
					if (current.isOther) {
						editMode = true;
						editor.setText(selected.get("other")?.label || "");
						refresh();
						return;
					}
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			}

			function render(width: number): string[] {
				// Cache MUST be width-keyed: pi-tui calls requestRender() but not
				// invalidate() on resize; stale wider lines crash the process.
				if (cachedLines && cachedWidth === width) return cachedLines;

				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));

				add(theme.fg("accent", "─".repeat(width)));
				addWrapped(lines, theme.fg("text", ` ${question}`), width);
				if (context) {
					lines.push("");
					addWrapped(lines, theme.fg("muted", ` ${context}`), width);
				}
				lines.push("");

				for (let i = 0; i < allItems.length; i++) {
					const item = allItems[i];
					const isFocused = i === optionIndex;
					const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

					if (item.isSubmit) {
						const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
						const styled = isFocused
							? theme.fg("accent", label)
							: theme.fg(selected.size > 0 ? "success" : "dim", label);
						add(`${prefix}${styled}`);
						continue;
					}

					if (item.isOther) {
						const other = selected.get("other");
						const marker = other ? "[x]" : "[ ]";
						const suffix = other ? ` — ${other.label}` : "";
						const styled = isFocused
							? theme.fg("accent", `${marker} ${item.label}${suffix}`)
							: theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
						add(`${prefix}${styled}`);
						continue;
					}

					const checked = selected.has(item.id);
					const marker = checked ? "[x]" : "[ ]";
					const label = `${marker} ${item.index}. ${item.label}`;
					const styled = isFocused ? theme.fg("accent", label) : theme.fg(checked ? "success" : "text", label);
					add(`${prefix}${styled}`);
					if (item.description) {
						addWrapped(lines, theme.fg("muted", item.description), width, "     ");
					}
				}

				if (editMode) {
					lines.push("");
					add(theme.fg("muted", " Write your custom answer:"));
					for (const line of editor.render(Math.max(1, width - 2))) {
						add(` ${line}`);
					}
					lines.push("");
					add(theme.fg("dim", " Enter to save • Esc to go back"));
				} else {
					lines.push("");
					if (selected.size === 0) {
						add(theme.fg("warning", " Select at least one answer before submitting."));
					}
					add(theme.fg("dim", " ↑↓ navigate • Space/digits toggle • Enter edit/submit • Esc cancel"));
				}

				add(theme.fg("accent", "─".repeat(width)));
				cachedLines = lines;
				cachedWidth = width;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
	);
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Question",
		description:
			"Ask the learner a single UNGRADED question and pause until they answer. Use it for goals, preferences, pacing, and decisions — never to test understanding (that is the quiz tool's job). Ask exactly one question per call; prefer separate calls over bundling unrelated questions.",
		promptSnippet:
			"Ask the learner one ungraded clarifying, preference, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call; make multiple calls for multiple questions.",
			"Never use this to test understanding — that is the quiz tool's job. This tool gathers goals, preferences, pacing, and decisions.",
			'Learners can always select "Other" to provide custom text input when options are given.',
			"Use multiSelect: true only when several answers to the same question are valid at once.",
			'If you recommend an option, make it first in the list and append "(Recommended)" to its label.',
			"Prefer this tool over guessing when the lesson's direction depends on the learner's choice.",
		],
		parameters: AskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}
			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "ask_user_question requires interactive mode", context);
			}

			return withUiLock(async () => {
				if (mode === "text") {
					const editorTitle = context ? `${params.question}\n\n${context}` : params.question;
					const answer = await ctx.ui.editor(editorTitle);
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const answer = await askSingleChoice(ctx, params.question, context, options);
					if (!answer) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [answer]);
				}

				const answers = await askMultiChoice(ctx, params.question, context, options);
				if (!answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, answers);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(
				args.options as Array<{ label: string; value?: string; description?: string }> | undefined,
			);
			let text = theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", String(args.question ?? ""));
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
