# AGENTS.md

Guidance for coding agents working in this repo. Read `README.md` and the
canonical design (`~/Documents/Key/design_initial.md`) before your first
change.

## Invariants

These hold in every line of code here. If a change breaks one, the change
is wrong.

1. **Information only flows forward.** A context never receives a return
   value and never waits on a successor it emitted. No call/return
   anywhere.
2. **Emit is the only verb.** All work is created by the `emit` tool in one
   atomic commit: the successor's conversation, its task, and (for joins)
   its wait edges. No other code path creates tasks.
3. **Join is birth, not resume.** A joining task is born waiting on existing
   tasks (`allSettled`) and runs only after they settle. No context stays
   running to await anything; `waitForTask` is never used between contexts.
4. **Acyclic by construction.** Wait edges may only name tasks minted in the
   same emission commit. Never add a way to wait on the future.
5. **Contexts are disposable.** Every context starts fresh with a prompt
   rendered from the goal document plus its task prompt (plus upstream refs
   for joins). Transcripts are audit logs; only the human's standing
   conversation persists.
6. **Three channels only**: prompts (control), git refs (data), the task
   graph (causality). No side channels, no shared in-memory state between
   contexts.
7. **Crash recovery is local and pure**: a context is a function of
   `(prompt, upstream refs) -> (artifacts, prompts)`. Restart resumes from
   the graph; nothing replays a conversation.
8. **Merge is prompt work.** Joining branches, validating, continuing — the
   model does it with git in its prompt. No merge machinery in the host.

## Setup and commands

- `pnpm install` — deps are registry packages (`@earendil-works/*`);
  no build step, no codegen.
- `node src/main.ts` — run the host (Node ≥ 23 strips TypeScript types).
- `KEY_MODEL="provider/modelId"` selects the worker model; provider
  credentials work as in `~/Projects/pi/scripts/issues`.
- There is no test suite and no linter.
- Storage and worktrees live under `.key/` (gitignored). Delete `.key/` to
  reset the system.

## Scope

Build: one host process (open Session on SQLite, `resume()`, standing
conversation, terminal CLI, live DAG from `watchTaskGraph`); one task kind
(`key.task`, phases `wait` → `run`, abort handler); the `emit` tool; a
session-scoped goal document rendered into every prompt; a worktree per
fresh worker (`.key/worktrees/task-<id>`, branch `task/<id>`, created
idempotently by the run phase, never cleaned up); per-emission model
override. Layout is `src/main.ts` (host) and `src/system.ts` (extension) —
nothing more.

Out — do not build, even if it looks easy: push notifications, phone or
desktop clients, WebSocket server / auth / remote anything, the proactive
ticker, git hooks or merge enforcement, compaction tuning, UI beyond
terminal lines, multiple sessions, scale-out.

## Style

TypeScript, ESM. Tabs, double quotes, semicolons. Comments carry intent
only, as in the pi repo.

## Durable notes

The durable package (`~/Projects/pi/packages/durable`) is the source of
truth; it is experimental and may drift. Verify against `README.md`,
`docs/spec.md`, and `test/examples/` before inventing mechanism; the mapping
is in the design doc. Patterns to consult: `22-subagent-foreground`
(replay-safe tool driving a conversation), `24-child-tasks` (waiting),
`13-recovery` (crash).

One non-obvious fact: `tx.createTask()` only creates `pending`. "Born
waiting" is the first phase handler's first commit — `{ status: "waiting",
on: [ids], policy: "allSettled", checkpoint: { phase: "run" } }`. There is
no birth-waiting API; don't look for one.
