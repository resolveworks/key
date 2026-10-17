## Spirit

Fast-moving, experimental, always current. This is an Arch Linux hacker's
project, not a product. We lean into frameworks and love defaults: reach
for what the platform and our deps already give us before writing our own.

Elegant, clean, tiger-style code. Tech debt is hell; cruft and hacks are
hell. The best change is one that deletes lines — refactor with negative
line counts. If a mechanism is growing, the design is wrong; find the
smaller shape.

Fail fast, loud, and hard. We are one hacker on one box: trust the user
and let mistakes surface. Choose honest errors over defensive validation
and the real path over a fallback. Guards: zero. Let what should crash
crash. A stack trace is the error message. When something is wrong,
make it visibly wrong — silence and recovery are where bugs hide.

## Invariants

These hold in every line of code here. If a change breaks one, the change
is wrong.

1. **Information only flows forward.** A context never receives a return
   value and never waits on a successor it emitted. No call/return
   anywhere.
2. **Emit creates workers; terminal creates the successor.** `emit` mints the
   worker leaves in one atomic commit. When a context ends, its terminal
   commit mints exactly one successor from the durable emit record: the join
   over the workers it emitted, or the human when a join emitted nothing. The
   model emits workers through the `emit` tool; the human emits through
   the client. No other code path creates tasks.
3. **Join is birth, not resume.** A joining task is born waiting on existing
   tasks (`allSettled`) and runs only after they settle. No context stays
   running to await anything; `waitForTask` is never used between contexts.
4. **Acyclic by construction.** Wait edges may only name tasks that already
   exist — the past. A join is minted at the emitter's terminal, so its edges
   name workers emitted earlier. Never add a way to wait on the future.
5. **Contexts are disposable.** Every context starts fresh with its task
   prompt (plus upstream refs for joins). Transcripts are audit logs; only
   the human's standing conversation persists.
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
- `pnpm serve` is `key serve` under `node --watch-path=src`: save a file and
  the host restarts. The restart *is* the crash-recovery path, so reload is
  the test for invariant 7 — do not add a hot-reload that skips it.
- `pnpm check` formats, lints (Biome), and typechecks (`tsc`, no emit).
  `pnpm fix` applies Biome's safe fixes and formatting.
- `.env` (gitignored) holds the provider key for the hardcoded model;
  see `.env.example`. Missing is fine until a command needs a model.
- There is no test suite, and you do not write smoke tests to check
  yourself. Trust your work the way you trust the user: if it is badly
  wrong, it will surface in use.
- All state lives under `.key/` (gitignored); delete it to reset.

## Scope

One host process owns the session and serves the live graph; a dumb client
renders it. One task kind, one `emit` tool. Keep the client free of state
— all of it belongs to the host.

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
