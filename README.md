# professor

AI-optimized learning for [pi](https://github.com/earendil-works/pi): a
private teacher with exactly one student — you.

The system runs a **probe → plan → teach** loop:

1. **Probe** — maps the exact edge of your understanding with graded
   multiple-choice quizzes (binary-searching each prerequisite strand).
2. **Plan** — reasons out a dependency path from your edge to the goal,
   fact-checks its own claims with researcher subagents, and commits to the
   path as a mermaid DAG.
3. **Teach** — one reasoning step per turn, a comprehension quiz after every
   step, and SVG diagrams that a subagent draws and *visually verifies*
   before you see them. Wrong answers get re-derived from a different angle,
   never repeated louder.

Everything is mirrored into a plain markdown lesson log with raw LaTeX
(renders in VS Code preview, GitHub, or any KaTeX-aware viewer); the
terminal shows a Unicode approximation (`x² + y² = r²`, `∇ × E⃗`).

## Install

```bash
pi install /path/to/professor      # or: pi install git:github.com/you/professor
```

Try without installing:

```bash
pi -e /path/to/professor
```

## Use

```
/teach differential forms
```

Or just ask to learn something — the `teach` skill triggers on its own.
`/log <path>` inspects or overrides the lesson log file; `/log off` unlinks it.

## Pieces

| Path | What |
|---|---|
| `extensions/quiz.ts` | `quiz` tool — interactive graded multiple choice. Digits or ↑↓/Enter to answer, `n` to attach a reasoning note, always an "I don't know" option (IDK is signal, not failure). Grading happens in-tool against the declared `correctAnswer` (matched by value, not index) and a results screen is shown to the learner before control returns to the model. |
| `extensions/mdlog.ts` | `lesson_log` tool + `/log` command + LaTeX→Unicode terminal transformer. Session content appends to the linked markdown file. |
| `extensions/delegate.ts` | `delegate` tool — runs subagents as isolated child `pi` processes (parallel-capable). |
| `agents/researcher.md` | Adversarial fact-checker for claims in the lesson plan. |
| `agents/svg-artist.md` | Draws instructional SVGs, rasterizes them, and inspects the result before delivering. |
| `skills/teach/SKILL.md` | The pedagogy: the probe → plan → teach protocol itself. Edit this to install your own learning philosophy. |
| `prompts/teach.md` | `/teach <topic>` entry point. |

## Development

```bash
pnpm install       # dev types only; pi loads TypeScript directly via jiti
pnpm run typecheck
```
