import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lessonState from "../extensions/lesson-state.ts";
import { createMockPi, makeCtx, todaysDateString } from "./helpers.ts";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "professor-state-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function create() {
	const mock = createMockPi();
	lessonState(mock.pi as never);
	return mock;
}

function isoDate(ts: string): string {
	return ts.slice(0, 10);
}

describe("lesson_state — open creates durable state", () => {
	it("writes real created/updated ISO timestamps (not hallucinated dates)", async () => {
		const mock = create();
		const tool = mock.tools.get("lesson_state")!;

		await tool.execute(
			"id",
			{ action: "open", topic: "Differential forms", goal: "Derive Stokes' theorem" },
			null,
			null,
			makeCtx(dir),
		);

		const stateFile = path.join(dir, "lessons", "differential-forms", "state.json");
		expect(fs.existsSync(stateFile)).toBe(true);

		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(state.topic).toBe("Differential forms");
		expect(new Date(state.createdAt).toString()).not.toBe("Invalid Date");
		expect(new Date(state.updatedAt).toString()).not.toBe("Invalid Date");
		// the timestamps reflect the real calendar date, not a placeholder
		expect(isoDate(state.createdAt)).toBe(todaysDateString());
		expect(isoDate(state.updatedAt)).toBe(todaysDateString());
	});

	it("creates the log-adjacent assets folder for the lesson", async () => {
		const mock = create();
		const tool = mock.tools.get("lesson_state")!;
		await tool.execute(
			"id",
			{ action: "open", topic: "Vector calculus", goal: "Compute line integrals" },
			null,
			null,
			makeCtx(dir),
		);
		expect(fs.existsSync(path.join(dir, "lessons", "vector-calculus", "assets"))).toBe(true);
	});
});

describe("lesson_state — plan + quiz-driven verification", () => {
	it("commits a plan and auto-verifies a node on a correct quiz answer", async () => {
		const mock = create();
		const tool = mock.tools.get("lesson_state")!;
		const ctx = makeCtx(dir);

		await tool.execute(
			"id",
			{ action: "open", topic: "Limits", goal: "Compute limits of sequences" },
			null,
			null,
			ctx,
		);
		await tool.execute(
			"id",
			{
				action: "plan",
				nodes: [{ id: "n1", title: "Convergence", deps: [] }],
			},
			null,
			null,
			ctx,
		);

		const stateFile = path.join(dir, "lessons", "limits", "state.json");
		let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(state.nodes[0].status).toBe("pending");

		// simulate the quiz tool finishing, id == node id → auto-verified
		const handler = mock.handlers.get("tool_execution_end")!;
		handler({
			toolName: "quiz",
			isError: false,
			result: {
				details: {
					questions: [{ id: "n1" }],
					answers: [{ id: "n1", correct: true, idk: false }],
					cancelled: false,
				},
			},
		});

		state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(state.nodes[0].status).toBe("verified");
		expect(state.nodes[0].attempts).toHaveLength(1);
		// the attempt timestamp is a real ISO date
		expect(new Date(state.nodes[0].attempts[0].at).toString()).not.toBe("Invalid Date");
	});
});
