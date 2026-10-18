# Testing Key

The suite verifies behavior through public seams: what an agent, a client, or
another process can observe. It does not pin private helpers, internal call
order, or the shape of intermediate state.

## Commands

- `pnpm test` runs the suite once.
- `pnpm test <file>` runs one file while developing.
- `pnpm test:watch` watches.
- `pnpm typecheck` also checks `tests/`.

Focused file first, full suite before finishing.

## Stack

Vitest in a single `node` project, one process per file. The config pins
`TZ=UTC`; use a frozen clock when asserting timestamps rather than sleeping.

## Layout

Test files live next to the code they exercise (`src/worktree.test.ts`), so a
change and its regression sit together. `tests/` holds process-wide setup and,
once more than one test needs it, a shared fixture or fake.

Helpers are added when a second test needs them, not in anticipation. Verify
durable's testing surface against its installed README and `.d.ts` files before
building on it.

## Isolation

Run Key's own logic for real; mock every subsystem it talks to. If a test would
exercise or assert on what a dependency — git, the model provider, durable's
scheduling — does with what Key hands it, that is the dependency's own
contract, tested where it lives, not ours:

- Open a `Harness` on `MemoryStorage`, not SQLite. Never touch
  `.key/session.sqlite`.
- Script model responses with pi-ai's `fauxProvider`, not the network. Tests
  never need `DEEPSEEK_API_KEY` or `.env`.
- Other processes go through a fake at the seam Key uses (`FakeGitEnv` in
  `tests/git.ts` records the commands and answers nothing): assert what Key
  asks for, never what the subsystem did. No repositories, temp directories,
  or commits.
- Start a real `Host` on a free port when testing HTTP; call exported functions
  directly when the transport is not what is under test.

Do not mock Key's own modules. Mock at the process boundary — the model
provider, the filesystem, the clock — and let the rest of the call path run.

## What to Cover

Behavior that would hurt if it silently changed:

- A context parks on wait edges, runs once, and ends.
- Forking mints children and a fresh successor in one terminal commit; the
  successor receives their settled results and never resumes the parent.
- A child gets its own worktree and branch, and cannot fork.
- Restart recovers a running context without duplicating work.
- The host's routes and SSE frames, including unknown conversations and empty
  prompts.
- Transcript rendering as a reader sees it: tool titles, diffs, collapsed
  output, stop reasons.

Assert the observable result, not that a helper was called. If a behavior is
only reachable through a private member, that is a seam problem to discuss, not
a reason to export internals.

## Naming

Names state the rule being protected, in the user's terms:
`"a successor waits for every child before it starts"`, not
`"test run phase 2"`.
