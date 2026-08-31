import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mdlog from "../extensions/mdlog.ts";
import { createMockPi, makeCtx, todaysDateString } from "./helpers.ts";

let dir: string;
let lessonLog: ReturnType<typeof mdlog>;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "professor-mdlog-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function createLog() {
	const mock = createMockPi();
	lessonLog = mdlog(mock.pi as never);
	return mock;
}

describe("lesson_log — file header date", () => {
	it("stamps today's real date into the header of a newly created log", async () => {
		const mock = createLog();
		const tool = mock.tools.get("lesson_log");
		expect(tool, "lesson_log tool registered").toBeTruthy();

		const logPath = path.join(dir, "lessons", "differential-forms", "lesson.md");
		const result = await tool!.execute("id", { path: logPath, title: "Differential forms" }, null, null, makeCtx(dir));

		const body = fs.readFileSync(logPath, "utf8");
		// header + italic date line, e.g. `# Differential forms\n\n*2026-08-31*\n\n`
		expect(body).toContain(`# Differential forms`);
		expect(body).toContain(`*${todaysDateString()}*`);
		expect(todaysDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		expect(result.content[0].text).toContain(logPath);
	});

	it("does not rewrite the header when re-linking an existing file", async () => {
		const mock = createLog();
		const tool = mock.tools.get("lesson_log")!;
		const logPath = path.join(dir, "lessons", "existing", "lesson.md");

		await tool.execute("id", { path: logPath }, null, null, makeCtx(dir));
		// tamper: simulate a file that already exists with a different header
		fs.appendFileSync(logPath, "some content\n");

		const before = fs.readFileSync(logPath, "utf8");
		await tool.execute("id", { path: logPath }, null, null, makeCtx(dir));
		const after = fs.readFileSync(logPath, "utf8");

		expect(after).toBe(before); // no duplicate header, no new date line
	});
});

describe("lesson_log — quiz results are appended", () => {
	it("appends formatted quiz results via the tool_execution_end event", async () => {
		const mock = createLog();
		const logPath = path.join(dir, "lessons", "topic", "lesson.md");
		await mock.tools.get("lesson_log")!.execute("id", { path: logPath }, null, null, makeCtx(dir));

		const handler = mock.handlers.get("tool_execution_end");
		expect(handler).toBeTruthy();

		const quizDetails = {
			questions: [
				{
					id: "n1",
					label: "n1",
					prompt: "What is 2 + 2?",
					options: ["3", "4", "5"],
					correctIndices: [2],
				},
			],
			answers: [{ id: "n1", selectedIndices: [2], correct: true, idk: false }],
			cancelled: false,
		};

		handler!({
			toolName: "quiz",
			isError: false,
			result: { details: quizDetails },
		});

		const body = fs.readFileSync(logPath, "utf8");
		expect(body).toContain("**Quiz**");
		expect(body).toContain("✅ What is 2 + 2? — 4");
		expect(body).toContain("Score: 1/1");
	});

	it("ignores non-quiz tool results when logging", async () => {
		const mock = createLog();
		const logPath = path.join(dir, "lessons", "topic", "lesson.md");
		await mock.tools.get("lesson_log")!.execute("id", { path: logPath }, null, null, makeCtx(dir));

		const handler = mock.handlers.get("tool_execution_end")!;
		handler({ toolName: "some_other_tool", isError: false, result: { details: {} } });

		const body = fs.readFileSync(logPath, "utf8");
		expect(body).not.toContain("**Quiz**");
	});
});

describe("lesson_log — description regression guard", () => {
	it("suggests a per-lesson folder path with no hardcoded date", () => {
		const mock = createLog();
		const tool = mock.tools.get("lesson_log")!;
		// the path example must be the folder layout, matching lesson_state's requirement
		expect(tool.description).toContain("lessons/<...>/lesson.md".replace("<...>", "differential-forms"));
		// and it must NOT contain a stale, hardcoded ISO-ish date embedded in a filename
		expect(tool.description).not.toMatch(/20\d\d-\d\d-\d\d/);
		// date responsibility is explicit: the tool stamps it, the model need not invent one
		expect(tool.description).toMatch(/date/i);
	});
});
