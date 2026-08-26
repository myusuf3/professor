/**
 * Quiz tool — graded multiple-choice questions with an interactive TUI.
 *
 * The teaching loop's measurement instrument: the model probes the edge of
 * the learner's understanding with batches of questions, and checks
 * comprehension after each teaching step with single ones.
 *
 * Every question gets an automatic "I don't know" option (IDK is signal,
 * not failure), and the learner can attach a free-text reasoning note to
 * any question ("n" key) that goes back to the model as calibration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { convertDollarSegments } from "../lib/math-unicode.ts";
import { withUiLock } from "../lib/ui-lock.ts";

interface QuizQuestion {
	id: string;
	label: string;
	prompt: string;
	options: string[];
	correctIndex: number; // 1-based
	explanation?: string;
}

interface QuizAnswer {
	id: string;
	selectedIndex: number; // 1-based; -1 = "I don't know"
	correct: boolean;
	idk: boolean;
	note?: string;
}

interface QuizResult {
	questions: QuizQuestion[];
	answers: QuizAnswer[];
	cancelled: boolean;
}

const QuizParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique identifier, e.g. 'line-integral'" }),
			label: Type.Optional(
				Type.String({ description: "Short tab label, e.g. 'Curl' (defaults to Q1, Q2...)" }),
			),
			prompt: Type.String({ description: "The question text. May contain LaTeX ($...$)." }),
			options: Type.Array(Type.String(), {
				description: "2-5 answer options. Plausible distractors, one correct.",
			}),
			correctAnswer: Type.String({
				description:
					"The correct option's exact text, verbatim from `options`. Grading is done by the tool against this value.",
			}),
			explanation: Type.String({
				description:
					"Shown to the learner after grading. Why the answer is right — address the tempting distractor, not just the fact.",
			}),
			shuffle: Type.Optional(
				Type.Boolean({
					description:
						"Shuffle option order before display (default true). Set false only when order is meaningful ('All of the above', ordered sequences).",
				}),
			),
		}),
		{ description: "Questions to ask" },
	),
});

const IDK = -1;

export default function quiz(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "Quiz",
		description: [
			"Ask the learner graded multiple-choice questions and get their answers with correctness.",
			"Use batches (3-6 questions) when probing understanding, single questions to verify a teaching step.",
			"Each question automatically gets an 'I don't know' option — treat IDK as a strong signal about the edge of understanding, never penalize it.",
			"Learners can attach free-text reasoning notes to answers; use them to calibrate.",
			"The tool grades every answer itself against correctAnswer and shows the learner their graded results before returning — never announce, predict, or re-grade results yourself.",
			"Options are shuffled before display, so never refer to options by number or letter in prose.",
			"Craft each distractor as a diagnostic for one specific misconception, keep all options the same length and register so the answer never stands out by format, and never add your own 'I don't know' option.",
		].join(" "),
		promptSnippet: "Graded multiple-choice quiz shown interactively to the learner",
		parameters: QuizParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text" as const, text: "Error: quiz UI requires interactive mode" }],
					details: { questions: [], answers: [], cancelled: true } satisfies QuizResult,
				};
			}
			if (params.questions.length === 0) {
				throw new Error("No questions provided");
			}
			const questions: QuizQuestion[] = params.questions.map((q, i) => {
				if (q.options.length < 2) throw new Error(`Question '${q.id}' needs at least 2 options`);
				const matches = q.options
					.map((opt, j) => j)
					.filter((j) => q.options[j].trim() === q.correctAnswer.trim());
				if (matches.length === 0) {
					throw new Error(
						`Question '${q.id}': correctAnswer ${JSON.stringify(q.correctAnswer)} does not match any option verbatim. Options: ${q.options
							.map((o) => JSON.stringify(o))
							.join(", ")}`,
					);
				}
				if (matches.length > 1) {
					throw new Error(`Question '${q.id}': correctAnswer matches ${matches.length} options — options must be distinct`);
				}
				// Shuffle display order (grading is by value, so this is free) —
				// otherwise the correct answer sits wherever the model habitually puts it.
				const order = q.options.map((_, j) => j);
				if (q.shuffle !== false) {
					for (let k = order.length - 1; k > 0; k--) {
						const r = Math.floor(Math.random() * (k + 1));
						[order[k], order[r]] = [order[r], order[k]];
					}
				}
				return {
					id: q.id,
					label: q.label || `Q${i + 1}`,
					prompt: q.prompt,
					options: order.map((j) => q.options[j]),
					correctIndex: order.indexOf(matches[0]) + 1,
					explanation: q.explanation,
				};
			});
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await withUiLock(() =>
				ctx.ui.custom<QuizResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let noteMode = false;
				let cachedLines: string[] | undefined;
				let cachedWidth = -1; // resize re-renders without invalidate — stale wider lines would crash
				let graded: QuizResult | null = null;
				const selections = new Map<string, number>(); // id → 1-based index or IDK
				const notes = new Map<string, string>();

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function currentQuestion(): QuizQuestion | undefined {
					return questions[currentTab];
				}

				/** Displayed options: the real ones plus trailing "I don't know". */
				function optionCount(q: QuizQuestion): number {
					return q.options.length + 1;
				}

				function allAnswered(): boolean {
					return questions.every((q) => selections.has(q.id));
				}

				function submit(cancelled: boolean) {
					const answers: QuizAnswer[] = questions
						.filter((q) => selections.has(q.id))
						.map((q) => {
							const sel = selections.get(q.id)!;
							return {
								id: q.id,
								selectedIndex: sel,
								correct: sel === q.correctIndex,
								idk: sel === IDK,
								note: notes.get(q.id),
							};
						});
					const outcome: QuizResult = { questions, answers, cancelled };
					if (cancelled) {
						done(outcome);
						return;
					}
					graded = outcome;
					refresh();
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					// Jump to the next unanswered question, else the Submit tab
					const next = questions.findIndex((q, i) => i > currentTab && !selections.has(q.id));
					const wrap = questions.findIndex((q) => !selections.has(q.id));
					currentTab = next !== -1 ? next : wrap !== -1 ? wrap : questions.length;
					optionIndex = 0;
					refresh();
				}

				function selectOption(displayIndex: number) {
					const q = currentQuestion();
					if (!q) return;
					const isIdk = displayIndex === optionCount(q) - 1;
					selections.set(q.id, isIdk ? IDK : displayIndex + 1);
					advanceAfterAnswer();
				}

				editor.onSubmit = (value) => {
					const q = currentQuestion();
					if (q) {
						const trimmed = value.trim();
						if (trimmed) notes.set(q.id, trimmed);
						else notes.delete(q.id);
					}
					noteMode = false;
					editor.setText("");
					refresh();
				};

				function handleInput(data: string) {
					if (graded) {
						if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done(graded);
						return;
					}
					if (noteMode) {
						if (matchesKey(data, Key.escape)) {
							noteMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
						else if (matchesKey(data, Key.escape)) submit(true);
						return;
					}
					if (!q) return;

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(optionCount(q) - 1, optionIndex + 1);
						refresh();
						return;
					}
					// Digit shortcut selects that option directly
					if (/^[1-9]$/.test(data)) {
						const idx = Number(data) - 1;
						if (idx < optionCount(q)) selectOption(idx);
						return;
					}
					if (data === "n") {
						noteMode = true;
						editor.setText(notes.get(q.id) ?? "");
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						selectOption(optionIndex);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					cachedWidth = width;
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					if (graded) {
						const score = graded.answers.filter((a) => a.correct).length;
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold(`Results — ${score}/${graded.answers.length}`)));
						lines.push("");
						for (const a of graded.answers) {
							const qq = questions.find((x) => x.id === a.id)!;
							const opt = (i: number) => convertDollarSegments(qq.options[i - 1]);
							const correctLabel = `${qq.correctIndex}. ${opt(qq.correctIndex)}`;
							if (a.idk) {
								addWrappedWithPrefix(
									" ",
									`${theme.fg("warning", "? ")}${theme.fg("text", `${qq.label}: I don't know`)}${theme.fg("muted", ` (answer: ${correctLabel})`)}`,
								);
							} else if (a.correct) {
								addWrappedWithPrefix(
									" ",
									`${theme.fg("success", "✓ ")}${theme.fg("text", `${qq.label}: ${a.selectedIndex}. ${opt(a.selectedIndex)}`)}`,
								);
							} else {
								addWrappedWithPrefix(
									" ",
									`${theme.fg("error", "✗ ")}${theme.fg("text", `${qq.label}: ${a.selectedIndex}. ${opt(a.selectedIndex)}`)}${theme.fg("muted", ` (→ ${correctLabel})`)}`,
								);
							}
							if (qq.explanation) {
								addWrappedWithPrefix("    ", theme.fg("dim", convertDollarSegments(qq.explanation)));
							}
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to continue"));
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						cachedLines = lines;
						return lines;
					}

					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = selections.has(questions[i].id);
							const box = isAnswered ? "■" : "□";
							const text = ` ${box} ${questions[i].label} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(isAnswered ? "success" : "muted", text);
							tabs.push(`${styled} `);
						}
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						tabs.push(
							`${
								isSubmitTab
									? theme.bg("selectedBg", theme.fg("text", submitText))
									: theme.fg(allAnswered() ? "success" : "dim", submitText)
							} →`,
						);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const sel = selections.get(question.id);
							if (sel === undefined) continue;
							const label =
								sel === IDK ? "I don't know" : `${sel}. ${convertDollarSegments(question.options[sel - 1])}`;
							const noteMark = notes.has(question.id) ? theme.fg("dim", " ✎") : "";
							addWrappedWithPrefix(
								" ",
								`${theme.fg("muted", `${question.label}: `)}${theme.fg("text", label)}${noteMark}`,
							);
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit answers"));
						} else {
							const missing = questions
								.filter((qq) => !selections.has(qq.id))
								.map((qq) => qq.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", theme.bold(convertDollarSegments(q.prompt))));
						lines.push("");
						const displayOptions = [...q.options.map(convertDollarSegments), "I don't know"];
						for (let i = 0; i < displayOptions.length; i++) {
							const selected = i === optionIndex;
							const chosen = (() => {
								const sel = selections.get(q.id);
								if (sel === undefined) return false;
								return sel === IDK ? i === displayOptions.length - 1 : sel === i + 1;
							})();
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const marker = chosen ? "● " : "";
							const isIdkOption = i === displayOptions.length - 1;
							const color = selected ? "accent" : isIdkOption ? "muted" : "text";
							addWrappedWithPrefix(prefix, theme.fg(color, `${marker}${i + 1}. ${displayOptions[i]}`));
						}
						if (notes.has(q.id)) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", `✎ note: ${notes.get(q.id)}`));
						}
						if (noteMode) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Reasoning note (Enter to save, Esc to discard):"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
						}
					}

					lines.push("");
					if (!noteMode) {
						const help = isMulti
							? "↑↓/digits answer • n note • Tab/←→ questions • Esc cancel"
							: "↑↓/digits answer • Enter confirm • n note • Esc cancel";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
				}),
			);

			if (result.cancelled) {
				return {
					content: [{ type: "text" as const, text: "Learner cancelled the quiz" }],
					details: result,
				};
			}

			const lines = result.answers.map((a) => {
				const q = questions.find((qq) => qq.id === a.id)!;
				const correctLabel = `${q.correctIndex}. "${q.options[q.correctIndex - 1]}"`;
				let line: string;
				if (a.idk) {
					line = `${q.label} (${a.id}): I DON'T KNOW — correct was ${correctLabel}`;
				} else if (a.correct) {
					line = `${q.label} (${a.id}): CORRECT — selected ${a.selectedIndex}. "${q.options[a.selectedIndex - 1]}"`;
				} else {
					line = `${q.label} (${a.id}): WRONG — selected ${a.selectedIndex}. "${q.options[a.selectedIndex - 1]}", correct was ${correctLabel}`;
				}
				if (a.note) line += `\n  learner's reasoning: ${a.note}`;
				return line;
			});
			const score = result.answers.filter((a) => a.correct).length;
			lines.push(`Score: ${score}/${result.answers.length}`);
			lines.push(
				"(This grading is authoritative and was already shown to the learner — do not re-grade or contradict it.)",
			);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as { label?: string; id: string }[]) || [];
			let text = theme.fg("toolTitle", theme.bold("quiz "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const labels = qs.map((q, i) => q.label || `Q${i + 1}`).join(", ");
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuizResult | undefined;
			if (!details || details.answers.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const lines = details.answers.map((a) => {
				const q = details.questions.find((qq) => qq.id === a.id)!;
				const opt = (i: number) => convertDollarSegments(q.options[i - 1]);
				if (a.idk) return `${theme.fg("warning", "? ")}${q.label}: I don't know`;
				if (a.correct) {
					return `${theme.fg("success", "✓ ")}${q.label}: ${a.selectedIndex}. ${opt(a.selectedIndex)}`;
				}
				return `${theme.fg("error", "✗ ")}${q.label}: ${a.selectedIndex}. ${opt(a.selectedIndex)} ${theme.fg(
					"muted",
					`(→ ${q.correctIndex}. ${opt(q.correctIndex)})`,
				)}`;
			});
			const score = details.answers.filter((a) => a.correct).length;
			lines.push(theme.fg("muted", `Score: ${score}/${details.answers.length}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
