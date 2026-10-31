<!-- biome-ignore-all format: keep the blank line before the fork list -->

# Key

**Cascading tasks.** Information only flows forward. There is no call/return
anywhere.

Key is a host and a terminal client. One process — the host — owns every
cascade on a durable session and serves it over HTTP; the client is a dumb
terminal chat that starts trajectories, streams them, and browses past ones.
The agents are coding agents: each conversation runs in a project directory
you point it at, on the models `/model` sets: one for conversations, one for
the children they spawn.

The implementation may change. The idea below does not.

## Usage

Needs Node 26 and pnpm. Durable and pi-ai are linked from `../pi/packages`;
build that checkout before running Key.

```
pnpm install
pnpm serve      # own the session and serve the graph on 127.0.0.1:7317
pnpm client     # chat with a running host
```

Put provider API keys in `~/.key/.env`; the host loads them on start. `/model`
in the client sets the two defaults, stored on the session: the model a new
conversation starts on, and the model the children it spawns run on. Tab
switches between conversations and children; enter sets the one the header
names. The picker lists pi's whole catalog, whether or not a provider key is
present; when a conversation runs on a provider, that provider's own env var
(`ZAI_CODING_CN_API_KEY` for `zai-coding-cn`, say) is what the request uses.
There is no model-default fallback: until both defaults are set, a new
conversation or a child fails loudly. Existing conversations keep the model
they started on. `KEY_THINKING_LEVEL` in the same file sets the level every
conversation runs at (a model without thinking runs at `off`; the default is
`high`). `KEY_BIND` in the same file
sets the interface the server listens on (`127.0.0.1` by default;
`0.0.0.0` to accept connections from off the box). `BRAVE_API_KEY` in the
same file gives every conversation `web_search`, the tool that searches the web.
`web_fetch`, the tool that reads a page as clean markdown, renders through the
stealth Chrome server on `ws://127.0.0.1:9222` — the `mine-browser.service`
podman quadlet, documented in [mine](../mine/README.md); `KEY_BROWSER_ENDPOINT`
in the same file points it elsewhere. A page over the output limits spills its
full content to a temp file, which `read` pages through.
Everything the host owns lives in `~/.key` — the session store is SQLite at
`~/.key/session.sqlite`. Set `KEY_HOST` to point the client at another host.

## HTTP API

The host's whole surface, served by hono; both streams are SSE.

```
GET  /api/conversations               transcripts, then changes (SSE)
GET  /api/conversations/:id           one transcript, then changes (SSE)
POST /api/run                         {prompt, cwd} → {conversation}: start a conversation in that directory
POST /api/complete                    {cwd, text, force}: the host's completion of one prompt line
POST /api/conversations/:id/messages  {prompt}: message a conversation
POST /api/conversations/:id/abort     interrupt a conversation: abort its current work
GET  /api/models                      the catalog and the two defaults
POST /api/models/defaults             {target, provider, modelId}: set a default
```

## Core idea

A **conversation** is a durable transcript and its agent configuration. `/new`
creates an ownerless conversation and submits a prompt directly. An ordinary
message submits directly to its conversation too, steering the current run when
one is busy.

A **task** is durable work that can own a conversation, produce a result, and be
waited on. Key uses tasks for the asynchronous branches of a cascade, not for
ordinary prompts.

A successful `fork` call immediately starts a child task in a fresh conversation
and git worktree. The child is background work of the forking conversation: the
forking run does not wait for it and never receives its result.

When a run that forked answers, it starts a successor task in another fresh
conversation. The successor waits for all that run's children to settle. Its
prompt contains the forking run's final answer and the children's settled
results.

If the successor forks again, its conversation owns the new children and the
next successor. That is the loop. The loop ends when a run forks nothing.

A **cascade** is a kickoff conversation followed by a chain of fresh successor
conversations, with forked child conversations branching off each step. Only a
child's settled result crosses into its parent's successor.

An **interrupt** aborts one conversation's current run. Background work in other
conversations keeps going. Interrupting a fork or successor's conversation ends
its task aborted, allowing anything waiting on that task to settle and run. An
interrupted run does not create a successor.

```text
cascade

  A          kickoff conversation; its run forks children
  A'         fresh successor: joins A's children; may fork more
  A''        fresh successor: joins the children forked by A'
  ...        until a run forks nothing
```

Information only ever enters a fresh successor. Nothing returns to the
conversation that forked it.

## Development

```
pnpm check     # biome + tsc
pnpm test      # vitest
```

Hooks live in `.githooks` — wire them with
`git config core.hooksPath .githooks`.
