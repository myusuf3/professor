/**
 * SVG authoring loop for the svg-artist subagent — three tools sharing one
 * session-managed source file:
 *
 *   write_svg  — write the full SVG source (first draft or full rewrite)
 *   edit_svg   — one exact-match old_text→new_text replacement (pi-edit
 *                semantics: must match exactly once)
 *   render_svg — render the CURRENT source to a PNG returned INLINE in the
 *                tool result, so the agent must see what it made before
 *                shipping; `save_as` publishes the SVG SOURCE to the given
 *                path (lessons keep the vector — the PNG is only proof)
 *
 * This file lives in lib/ (not extensions/) on purpose: it is loaded only
 * into delegate's child pi processes via `-e`, for agents whose frontmatter
 * lists these tool names — never into the teacher's own session.
 *
 * Rendering shells out to rsvg-convert, falling back to ImageMagick
 * (magick, then IM6 convert). Ported from amosblomqvist/learn; adapted to
 * Linux-first binaries and SVG-source publishing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BODY_FILE = "diagram.svg";
const RENDER_TIMEOUT_MS = 60_000;

/** Per-child-process managed source; one artist per process. */
let workDir: string | null = null;

function ensureWorkDir(): string {
	if (!workDir) {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "professor-svg-"));
	}
	return workDir;
}

function bodyPath(): string {
	return path.join(ensureWorkDir(), BODY_FILE);
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: ensureWorkDir() });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

/** rsvg-convert (crisp 2x), falling back to ImageMagick's magick, then IM6 convert. */
async function renderToPng(svgPath: string, outPath: string): Promise<{ ok: boolean; res: RunResult }> {
	let res = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], RENDER_TIMEOUT_MS);
	if (res.code === 0 && fs.existsSync(outPath)) return { ok: true, res };
	for (const im of ["magick", "convert"]) {
		const alt = await run(im, ["-density", "192", "-background", "white", svgPath, outPath], RENDER_TIMEOUT_MS);
		if (alt.code === 0 && fs.existsSync(outPath)) return { ok: true, res: alt };
		if (alt.code !== null) res = alt;
	}
	return { ok: false, res };
}

/**
 * Exact-match single replacement, matching pi's built-in edit: old_text must
 * appear exactly once. Returns updated content and match offset, or throws.
 */
function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
	if (oldText === "") throw new Error("`old_text` must be non-empty.");
	if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.");
	const first = current.indexOf(oldText);
	if (first === -1) {
		throw new Error("`old_text` not found in the current source — match it exactly.");
	}
	if (current.indexOf(oldText, first + 1) !== -1) {
		let n = 0;
		for (let i = current.indexOf(oldText); i !== -1; i = current.indexOf(oldText, i + oldText.length)) n++;
		throw new Error(`\`old_text\` appears ${n} times — add surrounding context to make it unique.`);
	}
	return { updated: current.slice(0, first) + newText + current.slice(first + oldText.length), index: first };
}

/** A small numbered window of `content` around char offset `index`. */
function snippetAround(content: string, index: number, contextLines = 3): string {
	const hitLine = content.slice(0, index).split("\n").length - 1;
	const lines = content.split("\n");
	const start = Math.max(0, hitLine - contextLines);
	const end = Math.min(lines.length - 1, hitLine + contextLines);
	const width = String(end + 1).length;
	const out: string[] = [];
	for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`);
	return out.join("\n");
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export default function svgTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "write_svg",
		label: "Write SVG",
		description:
			"Write the FULL SVG source to this session's managed file (your first draft or a complete rewrite). " +
			"You do NOT name the file — edit_svg and render_svg act on the same one. " +
			"`source` is a complete `<svg ...>…</svg>` document with a viewBox, readable font sizes, and a white or " +
			"transparent background. Writing does NOT render — call render_svg when ready. For a small fix, prefer edit_svg.",
		parameters: Type.Object({
			source: Type.String({ description: "The complete SVG document, from `<svg` to `</svg>`." }),
		}),
		async execute(_id, params) {
			const source = (params.source ?? "").trim();
			if (!source) throw new Error("`write_svg` requires a non-empty `source`.");
			if (!source.includes("<svg")) throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.");
			fs.writeFileSync(bodyPath(), source, "utf8");
			const lines = source.split("\n").length;
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${lines}-line SVG source.\nCall render_svg to see it, or edit_svg to tweak it.`,
					},
				],
				details: { ok: true, lines },
			};
		},
	});

	pi.registerTool({
		name: "edit_svg",
		label: "Edit SVG",
		description:
			"Make a single exact-match replacement in this session's SVG source — the same contract as pi's built-in " +
			"edit, locked to the one managed file. `old_text` must appear EXACTLY ONCE (include surrounding context for " +
			"uniqueness); on 0 or >1 matches the call fails and nothing changes. Call write_svg first. Editing does NOT render.",
		parameters: Type.Object({
			old_text: Type.String({ description: "Exact substring of the current source to replace (must match once)." }),
			new_text: Type.String({ description: "Replacement text for `old_text`." }),
		}),
		async execute(_id, params) {
			const file = bodyPath();
			if (!fs.existsSync(file)) throw new Error("edit_svg: no source yet — call write_svg first.");
			const current = fs.readFileSync(file, "utf8");
			const { updated, index } = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""));
			fs.writeFileSync(file, updated, "utf8");
			return {
				content: [
					{
						type: "text" as const,
						text: `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_svg to see it.`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "render_svg",
		label: "Render SVG",
		description:
			"Render the CURRENT session SVG source to a PNG and return it inline so you can SEE the picture and " +
			"iterate. You do NOT pass the source here — it comes from the managed file; call write_svg first. " +
			"Iterate with no `save_as` (preview only). When the picture is correct, call once more with `save_as` set " +
			"to the destination .svg path from your brief: that publishes the SVG SOURCE there (the lesson keeps the " +
			"vector; the PNG is your proof) and returns the final render for a last look. On a render error you get " +
			"the error text instead of an image — fix with edit_svg and re-render.",
		parameters: Type.Object({
			save_as: Type.Optional(
				Type.String({
					description:
						"Destination .svg path from the brief (e.g. lessons/<topic>/assets/<slug>.svg). When set, the " +
						"current SVG source is published there. Omit for a preview-only render.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = bodyPath();
			if (!fs.existsSync(file)) throw new Error("render_svg: no source yet — call write_svg first.");

			const outPath = path.join(ensureWorkDir(), `render-${Date.now()}.png`);
			const { ok, res } = await renderToPng(file, outPath);
			if (!ok) {
				const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n");
				const note = res.timedOut ? "SVG render timed out.\n\n" : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${note}SVG render FAILED — no image produced (tried rsvg-convert, magick, convert). Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}`,
						},
					],
					details: { ok: false },
				};
			}

			const data = fs.readFileSync(outPath).toString("base64");
			const content: Content[] = [];

			if (params.save_as) {
				const target = String(params.save_as);
				if (!target.endsWith(".svg")) {
					throw new Error(`render_svg: save_as must be a .svg path, got '${target}'`);
				}
				const dest = path.isAbsolute(target) ? target : path.join(ctx.cwd, target);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(file, dest);
				content.push({
					type: "text",
					text: `Published SVG source to ${dest}.\n\nLOOK at the final render below and confirm it is correct before returning RESULT: ${target}.`,
				});
				content.push({ type: "image", data, mimeType: "image/png" });
				return { content, details: { ok: true, published: dest } };
			}

			content.push({
				type: "text",
				text: "Preview render (not yet published). LOOK: are directions, proportions, and relationships correct? Labels clear and unclipped? Rendering success only proves it parsed. Fix with edit_svg, or re-render with `save_as` to publish.",
			});
			content.push({ type: "image", data, mimeType: "image/png" });
			return { content, details: { ok: true } };
		},
	});
}
