# AGENTS.md

Guidance for coding agents working in this repo. Read `README.md` and the
canonical design (`~/Documents/Key/design_initial.md`) before your first
change.

## Spirit

Fast-moving, experimental, always current. This is an Arch Linux hacker's
project, not a product. We lean into frameworks and love defaults: reach
for what the platform and our deps already give us before writing our own.

Elegant, clean, tiger-style code. Tech debt is hell; cruft and hacks are
hell. The best change is one that deletes lines — refactor with negative
line counts. If a mechanism is growing, the design is wrong; find the
smaller shape.

Fail fast, loud, and hard. We are one hacker on one box: trust the user
and let mistakes surface. Choose honest errors over defensive validation,
the real path over a fallback, a guard only for states that can actually
happen. Let what should crash crash. A stack trace is the error message.
When something is wrong, make it visibly wrong — silence and recovery are
where bugs hide.

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
  no build step, no codegen. Node ≥ 23 runs the TypeScript directly.
- `pnpm key` runs the host CLI and prints its own usage; treat that as the
  source of truth, not this file.
- `.env` (gitignored) supplies `KEY_MODEL="provider/modelId"` and that
  provider's key; see `.env.example`. Missing is fine until a command
  needs a model.
- There is no test suite and no linter.
- All state lives under `.key/` (gitignored); delete it to reset.

## Scope

One host process owns the session and serves the live graph; a dumb client
renders it. One task kind, one `emit` tool, one goal document rendered
into every prompt, per-emission model override. Keep the client free of
state — all of it belongs to the host.

Out — do not build, even if it looks easy: push notifications, phone or
desktop clients, WebSocket server / auth / remote anything, the proactive
ticker, git hooks or merge enforcement, compaction tuning, UI beyond
terminal lines, multiple sessions, scale-out.

## Style

TypeScript, ESM. Tabs, double quotes, semicolons. Comments carry intent
only, as in the pi repo.

## Durable notes

The durable package is experimental and may drift; verify against its own
README and examples before inventing mechanism. Consult the pattern
matching your need — a replay-safe tool driving a conversation, waiting on
other tasks, crash recovery — rather than trusting memory.

One non-obvious fact: `tx.createTask()` only creates `pending`. "Born
waiting" is the first phase handler's first commit — `{ status: "waiting",
on: [ids], policy: "allSettled", checkpoint: { phase: "run" } }`. There is
no birth-waiting API; don't look for one.
