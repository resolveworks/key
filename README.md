<!-- biome-ignore-all format: keep the blank line before the fork list -->

# Key

**Cascading contexts.** Information only flows forward. There is no call/return
anywhere.

Key is a host and a terminal client. One process — the host — owns every
cascade on a durable session and serves it over HTTP; the client is a dumb
terminal chat that starts trajectories, streams them, and browses past ones.
The agents are coding agents: each context runs in a project directory you
point it at, on the model `KEY_MODEL` picks (`deepseek/deepseek-flash` by
default).

The implementation may change. The idea below does not.

## Usage

Needs Node 26 and pnpm.

```
pnpm install
pnpm serve      # own the session and serve the graph on 127.0.0.1:7317
pnpm client     # chat with a running host
```

Put `DEEPSEEK_API_KEY=...` in `~/.key/.env`; the host loads it on start.
`KEY_MODEL=provider/model` in the same file picks what every conversation
runs on — any provider in pi's catalog, keyed by that provider's own env var
(`ZAI_CODING_CN_API_KEY` for `zai-coding-cn`, say). `KEY_THINKING_LEVEL` in
the same file sets the level every conversation runs at (a model without
thinking runs at `off`; the default is `high`).
Everything the host owns lives in `~/.key` — the session store is SQLite at
`~/.key/session.sqlite`. Set `KEY_HOST` to point the client at another host.

## HTTP API

The host's whole surface, served by hono; both streams are SSE.

```
GET  /api/conversations               transcripts, then changes (SSE)
GET  /api/conversations/:id           one transcript, then changes (SSE)
POST /api/run                         {prompt, cwd}: start a context in that directory
POST /api/complete                    {cwd, text, force}: the host's completion of one prompt line
POST /api/conversations/:id/messages  {prompt}: message a context
POST /api/conversations/:id/abort     interrupt a context: abort its conversation's current work
```

## Core idea

Every agent invocation is a **fresh context**. A context runs once, may fork
child contexts, and then ends. It never waits for a child, never resumes, and
never receives a child's result.

When a context forks, it mints:

- a child task for each child context, to run in a fresh conversation of its own;
- a successor task, to run in a fresh conversation of its own once those children
  settle.

The successor starts with the forking context's last message and the children's
results. It is not the forking context continuing. It is a new context.

If the successor forks again, the same thing happens: it forks children and mints
a new successor that will run when they settle. That is the loop. The loop ends
when a context forks nothing.

A **cascade** is one loop: a kickoff context followed by a chain of fresh
successor contexts. It can fork and join many times. The first context is the
human kickoff; every later context is a loop iteration.

Every cascade context runs in a conversation of its own; the cascade never resumes
one. A human message is the one way back in: it steers the open conversation
directly. Each forked child is its own branch; only its settled result crosses
into the parent's successor.

An **interrupt** aborts one context's run where it stands. The context ends
terminal aborted — no answer, and the forks it recorded die with it — so
whoever waits on it settles and runs. The transcript records the interrupt
where it landed. A message to its conversation continues the work as a fresh
context, which mints only its own forks.

```text
cascade

  A          kickoff context; forks children
  A'         fresh successor: joins A's children; may fork more
  A''        fresh successor: joins the children forked by A'
  ...        until a context forks nothing
```

Information only ever enters a fresh context. Nothing returns to the context
that forked it.

## Development

```
pnpm check     # biome + tsc
pnpm test      # vitest
```

Hooks live in `.githooks` — wire them with
`git config core.hooksPath .githooks`.
