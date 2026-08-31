/**
 * Regression guard: the original bug was a hardcoded ISO-style date
 * (`2026-08-23`) baked into a tool description, which the model kept
 * copying into freshly created lesson filenames as if it were real.
 *
 * Lesson dates are computed at runtime (`new Date()`); there is no reason
 * for any literal `20XX-XX-XX` to exist in extension/lib source. Note it
 * must only ever be the CURRENT year that could legitimately appear, so we
 * flag any of the form 2000-2099.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const roots = ["extensions", "lib"];

/** All TypeScript source under the given roots, plus their full text. */
const sources: { file: string; text: string }[] = (() => {
	const out: { file: string; text: string }[] = [];
	for (const root of roots) {
		const walk = (p: string) => {
			for (const e of fs.readdirSync(p, { withFileTypes: true })) {
				const full = path.join(p, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.name.endsWith(".ts")) out.push({ file: full, text: fs.readFileSync(full, "utf8") });
			}
		};
		walk(root);
	}
	return out;
})();

describe("no hardcoded ISO-style dates in source", () => {
	it("finds no literal 20XX-XX-XX date in any extension or lib file", () => {
		const offenders = sources
			.map(({ file, text }) => {
				const lines = text.split("\n");
				const hits: string[] = [];
				lines.forEach((line, i) => {
					// skip code that legitimately computes dates (Date, toISOString, toLocaleDateString)
					// — we only flag *literal* date-looking strings in source
					if (/\b20\d{2}-\d{2}-\d{2}\b/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
				});
				return hits;
			})
			.flat();

		expect(offenders).toEqual([]);
	});
});
