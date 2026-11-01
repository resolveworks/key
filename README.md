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

Needs Node 26, pnpm, and bubblewrap. Durable and pi-env are linked from
`../pi/packages`; build that checkout before running Key. `pnpm build:env`
builds pi-env and its daemon and puts the daemon where the host finds it.

```
pnpm install
pnpm build:env
pnpm serve      # own the session and serve the graph on 127.0.0.1:7317
pnpm client     # chat with a running host
```

Every conversation runs under bubblewrap: the host filesystem is read-only, its
/tmp is a private tmpfs, the worktree (and git common dir) and the pnpm, uv and
cargo caches are writable, and the host home is readable. Network is available.

Configure providers from the client with `/login`: it lists pi's providers and
their account or API-key methods, asks what the provider asks, and stores the
credential in `~/.key/auth.json`. There is no env file. `/model` in the client
sets the two defaults, stored on the session: the model a new conversation
starts on, and the model the children it spawns run on. Tab switches between
conversations and children; enter sets the one the header names. The picker
lists the configured providers' models; a conversation on a provider without a
credential fails loudly when it runs. There is no model-default fallback:
until both defaults are set, a new conversation or a child fails loudly.
Existing conversations keep the model they started on.

`/thinking` sets the two levels, stored on the session with the model defaults:
what a new conversation starts at, and what the children it spawns run at. Tab
switches between conversations and children; enter sets the one the header
names. Both default to `high` until set; each conversation clamps the level to
what its model supports, so a model without thinking runs at `off`. Existing
conversations keep the level they started on. `KEY_BIND` sets the
interface the server listens on (`127.0.0.1` by default; `0.0.0.0` to accept
connections from off the box). `BRAVE_API_KEY` in the host's environment gives
every conversation `web_search`, the tool that searches the web. `web_fetch`,
the tool that reads a page as clean markdown, renders through the stealth Chrome
server on `ws://127.0.0.1:9222` — the `mine-browser.service` podman quadlet,
documented in [mine](../mine/README.md); `KEY_BROWSER_ENDPOINT` points it
elsewhere. A page over the output limits spills its full content to a temp file,
which `read` pages through.
Everything the host owns lives in `~/.key` — the session store is SQLite at
`~/.key/session.sqlite`, credentials at `~/.key/auth.json`. Set `KEY_HOST` to
point the client at another host.

## HTTP API

The host's whole surface, served by hono; both streams are SSE.

```
GET  /api/conversations               transcripts, then changes (SSE)
GET  /api/conversations/:id           one transcript, then changes (SSE)
POST /api/run                         {prompt, cwd} → {conversation}: start a conversation in that directory
POST /api/complete                    {cwd, text, force}: the host's completion of one prompt line
POST /api/conversations/:id/messages  {prompt}: message a conversation
POST /api/conversations/:id/abort     interrupt a conversation: abort its current work
GET  /api/models                      the configured models and the two defaults
POST /api/models/defaults             {target, provider, modelId}: set a default
GET  /api/thinking                    the levels conversations and children run at
POST /api/thinking                    {target, level}: set one
GET  /api/providers                   providers and their auth methods
POST /api/login                       {provider, type}: run a provider login
GET  /api/login                       the login's prompts and notices (SSE)
POST /api/login/respond               {id, value}: answer the waiting prompt
POST /api/login/abort                 cancel the login
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
prompt carries only what it can gather from: each fork's branch, and the ids of
the conversations `ask` reaches. It contains none of their words.

The `ask` tool reads a settled conversation's own context and answers one
question over it. The conversation is never appended to. Askers can query their
predecessor and the children it forked, one or many questions at a time.

If the successor forks again, its conversation owns the new children and the
next successor. That is the loop. The loop ends when a run forks nothing.

A **cascade** is a kickoff conversation followed by a chain of fresh successor
conversations, with forked child conversations branching off each step. Only
branch names and conversation ids cross into a successor; its questions cross
back through `ask` without changing the conversations they ask.

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

Information only ever enters a fresh successor. The past stays frozen: ask
reads a conversation, never appends to it.

## Development

```
pnpm check     # biome + tsc
pnpm test      # vitest
```

Hooks live in `.githooks` — wire them with
`git config core.hooksPath .githooks`.
