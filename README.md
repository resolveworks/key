# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](../pi/packages/durable). A proof of concept,
not a product.

## The idea

Cascading contexts instead of an orchestrator with workers-as-children.
Information only flows forward. There is no call/return anywhere in the
system.

- A **context** wakes with an input, runs, **emits** tasks, and is terminal
  before its successors start. No context waits for a child or receives a
  return value. Join is not control flow returning; it is a new context
  created waiting on completed ones.
- Three channels, only: **prompts** (control), **git refs** (data), **the
  task graph** (causality).
- Transcripts are audit logs, not context. Every context starts fresh with
  its prompt.
- Acyclic by construction: wait edges are minted at emission and can only
  point at tasks that already exist.
- Crash recovery is local: a context is a pure function of
  `(prompt, upstream refs) -> (artifacts, prompts)`. Kill the host; restart
  it; the graph says where work continues.

One noun, one verb: a **task** is a prompt plus who runs it (a model in its
own git worktree, or the human). **Emit** is the only verb — fork is
emitting; join is waiting.

```
task/41 ─┐
task/42 ─┼─▶ task/46 (waiting on 41–43, prompt = handoff) ─▶ task/47 ─┐
task/43 ─┘                                                 task/48 ─┼─▶ task/52 (deps) ─▶ ...
                                                          task/49 ─┘
```

The one standing address is `human`: a task addressed to the human runs in
the standing conversation instead of a fresh one. The human's output is
`emit` calls — the same verb everyone else uses.

The full design lives in `~/Documents/Key/design_initial.md`.

## The spike

Everything runs in one host process over one SQLite-backed durable Session:

- one task kind (`key.task`), phases `wait` → `run`;
- the `emit` tool, replay-safe and crash-idempotent;
- a worktree and `task/<id>` branch per fresh worker; joins and the human
  run on the main checkout — merging is prompt work, not machinery;
- a dumb terminal CLI: talk to the standing conversation, watch the DAG.

Deliberately out: push notifications, phone/desktop clients, remote
anything, the proactive ticker, merge enforcement.

## Run

```bash
pnpm install
export KEY_MODEL="deepseek/deepseek-flash"
node --conditions=source src/main.ts
```

Requires Node ≥ 23 and the pi repo checked out at `~/Projects/pi`
(dependencies are `file:` links into it). Follow `demo.md` for the
fork → join → human walkthrough, including the kill-9 restart.

The task graph is the only coordination; git is the only data; prompts are
the only control; contexts are disposable; and the human is the one standing
address — the only context whose output includes more of itself.
