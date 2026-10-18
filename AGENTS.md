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

## Constraints

- Behavior tests live under `tests/`; `tests/AGENTS.md` is the policy.
- The restart is the crash-recovery path; do not add a hot-reload that
  skips it.
- The pre-commit hook runs biome (with auto-fix), `pnpm check`, and
  `pnpm test`. Do not run these unprompted.

## Scope

One task kind, one `fork` tool.

Out — do not build, even if it looks easy: push notifications, phone or
desktop clients, WebSocket server / auth / remote anything, the proactive
ticker, compaction tuning, UI beyond terminal lines, multiple sessions,
scale-out.

## Style

Comments carry intent only, as in the pi repo.

## Durable notes

The durable package is experimental and may drift; verify against its own
README before inventing mechanism. Consult the pattern matching your need
— a replay-safe tool driving a conversation, waiting on other tasks,
crash recovery — rather than trusting memory.
