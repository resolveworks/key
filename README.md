# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
A proof of concept, not a product.

Information only flows forward; there is no call/return anywhere. The
rules that hold in every line of code live in `AGENTS.md`; the long-form
design is a separate document.

## Run

```bash
pnpm install
cp .env.example .env   # then fill in the key
pnpm key serve         # own the session and serve the graph
pnpm key client        # in another terminal: type a prompt to start a trajectory
```

In the client, open a transcript and type to send another message into that same
conversation; your message runs as a fresh context in the existing trajectory.

`pnpm key` with no command prints its own usage — it is the source of
truth for the CLI. The host reads `.env` from the working directory; a
missing file is fine until a command needs a model.

## Check

```bash
pnpm check   # Biome: format + lint, then tsc
pnpm fix     # apply Biome's safe fixes and formatting
```
