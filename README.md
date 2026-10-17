# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
A proof of concept, not a product.

Information only flows forward; there is no call/return anywhere. Working
agreements live in `AGENTS.md`.

## Run

```bash
pnpm install
cp .env.example .env   # then fill in the key
pnpm serve             # own the session and serve the graph
pnpm client            # in another terminal: type a prompt to start a trajectory
```

Restart the host to pick up changes in `src/`. A restart is the durable
recovery path: the host reopens `.key/` and resumes from the graph, so work in
flight is picked up by the next process.

In the client, type a prompt to start a trajectory. `/resume` lists past
conversations: `↑`/`↓` to select, `enter` to open. Inside a transcript, type to
send another message into that same conversation; your message runs as a fresh
context in the existing trajectory. `/new` abandons the open transcript: the
next prompt starts a fresh trajectory.

Transcripts are drawn the way the [pi](https://github.com/badlogic/pi-mono)
coding agent draws them: the prompt in a full-width box, assistant text as
markdown, thinking in italics, and each tool call its own box whose background
says how it is going — grey while running, green when it worked, red when it
failed. An edit shows its colored diff; other output shows its last few lines.
`src/theme.ts` holds pi's dark palette, `src/trajectory.ts` the components.

`pnpm serve --help` prints the CLI's own usage. The host reads `.env`
from the working directory; a missing file is fine until a command needs
a model.

## Agent files

Every context starts with the project's agent instructions. In each directory
from the working directory up to the filesystem root, the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` is
loaded; outermost first, so the nearest file reads as the most specific. The
files are rendered as `<project_context>` and re-read on every model request,
so an edit reaches the next turn without a restart.

## Check

```bash
pnpm check   # Biome: check formatting + lint, then tsc
pnpm fix     # apply Biome's safe fixes and formatting
```
