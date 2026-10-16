# AGENTS.md

Guidance for coding agents working in this repo. The pitch and run
instructions are in `README.md`; the canonical design is
`~/Documents/Key/design_initial.md` — read both before your first change.
This file carries the rules and the implementation decisions.

## Invariants

These hold in every line of code here. If a change breaks one, the change
is wrong.

1. **Information only flows forward.** A context never receives a return
   value, and nothing ever waits on a successor it emitted. No call/return
   anywhere.
2. **Emit is the only verb.** All work is created by the `emit` tool, in one
   atomic commit: the successor's conversation, its task, and (for joins)
   its wait edges. No other code path creates tasks.
3. **Join is birth, not resume.** A joining task is born waiting on existing
   tasks (`allSettled`) and runs only after they settle. No context stays
   running to await anything.
4. **Acyclic by construction.** Wait edges may only name tasks minted in the
   same emission commit. Never add a way to wait on the future.
5. **Contexts are disposable.** Every context starts fresh with a prompt
   rendered from the goal document plus its task prompt (plus upstream refs
   for joins). Transcripts are audit logs; the system never resumes a
   context's conversation. The standing conversation (the human) is the one
   exception.
6. **Three channels only**: prompts (control), git refs (data), the task
   graph (causality). No side channels, no shared in-memory state between
   contexts.
7. **Crash recovery is local and pure**: a context is a function of
   `(prompt, upstream refs) -> (artifacts, prompts)`. Restart resumes from
   the graph; nothing replays a conversation.
8. **Merge is prompt work.** Joining branches, validating, continuing — the
   model does it with git in its prompt. No merge machinery in the host.

## Setup and commands

- `pnpm install` — deps are `file:` links into `~/Projects/pi/packages/*`;
  no build step, no codegen.
- `node --conditions=source src/main.ts` — run the host (Node ≥ 23; the
  `source` condition loads the pi packages' TypeScript directly).
- `KEY_MODEL="provider/modelId"` selects the worker model; provider
  credentials work as in `~/Projects/pi/scripts/issues`.
- There is no test suite and no linter. The demo in `demo.md` is the check:
  run it before declaring work done, including the kill-9 restart.
- Storage and worktrees live under `.key/` (gitignored). Delete `.key/` to
  reset the system.

## Scope

In: one host process (open Session on SQLite, `resume()`, standing
conversation, terminal CLI, live DAG from `watchTaskGraph`); one task kind
(`key.task`, phases `wait` → `run`, abort handler); the `emit` tool; a
session-scoped goal document rendered into every prompt; a worktree per
fresh worker (`.key/worktrees/task-<id>`, branch `task/<id>`, created
idempotently by the run phase, never cleaned up); per-emission model
override; `demo.md`.

Out — do not build, even if it looks easy: push notifications, phone or
desktop clients, WebSocket server / auth / remote anything, the proactive
ticker, git hooks or merge enforcement, compaction tuning, UI beyond
terminal lines, multiple sessions, scale-out.

## Layout and style

- `src/main.ts` (host), `src/system.ts` (extension: task kind, emit, goal
  doc, prompt rendering, worktrees), `demo.md`. Nothing more unless the
  demo demands it.
- TypeScript, ESM. Style matches the pi repo: tabs, double quotes,
  semicolons.
- Comments carry intent only, as in the pi repo.

## Implementation decisions (verified against durable)

The durable package (`~/Projects/pi/packages/durable`: `README.md`,
`docs/spec.md`, `test/examples/`) is the source of truth; it is
experimental and may drift. Decisions verified so far:

- The whole system is one `Harness.open(storage, { models, registry, env,
  settings })` on `openNodeSqliteStorage` from
  `@earendil-works/pi-durable/storage/sqlite/node`.
- **Task** = `defineTask({ name: "key.task", ... })`, always created
  `ownership: { kind: "conversation" }` — top-level, so emitters die
  unheld. Note: `tx.createTask()` only creates `pending`. "Born waiting" is
  the first phase handler's first commit: `{ status: "waiting", on: [ids],
  policy: "allSettled", checkpoint: { phase: "run" } }`. There is no
  birth-waiting API; don't look for one.
- **A task's conversation is its context.** A fresh worker's emission
  creates an ownerless conversation plus the task in it. The run phase
  drives `runtime.conversation(runtime.conversationId)`, `configure({
  model, cwd })`, submits the rendered prompt with `requestId:
  "run:<taskId>"`, and awaits `submission.wait()`. Crash replay re-finds
  both.
- **Human address**: a task addressed to `human` lives in the standing
  conversation (`harness.root()`) and submits its prompt there. The human's
  reply is converse; the human's output is `emit` calls — the same verb.
- **Emit**: a tool, `replay: "safe"`, idempotent via `api.memo` — one memo
  key per call holds the created ids; a rerun after a crash returns them
  instead of re-creating. `api.commit` mints conversation + task + wait
  edges atomically. It validates that every waited-on id exists in the same
  transaction.
- **Worktrees**: the run phase execs git via `runtime.env()` before
  `configure`, memoized the same way.
- **Terminal outcome**: the run phase commits `{ summary, branch }` so
  joins can render upstream refs and outcomes (`runtime.outcomes()`).
- **Goal document**: `defineDoc({ scope: "session" })`; the host seeds it,
  prompts render it.
- Reference patterns in durable's `test/examples/`: `22-subagent-foreground`
  (replay-safe tool driving a conversation), `24-child-tasks` (waiting),
  `13-recovery` (crash). Consult them before inventing mechanism.

## Done means

`node --conditions=source src/main.ts` runs the demo from `demo.md`: the
goal forks into 2–3 workers in their own worktrees, a join merges their
branches on main, the human gets the result in the standing conversation —
and killing the host mid-worker, then restarting, completes the same run
from the graph. No context ever waits on a child; `grep` finds no
`waitForTask` outside the run phase's own submission.
