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
pnpm serve             # own the session and serve the graph; restarts on changes in src/
pnpm key client        # in another terminal: type a prompt to start a trajectory
```

A restart is the durable recovery path, so reloading is a crash test: the
host reopens `.key/` and resumes from the graph. Work in flight when you save a
file is picked up by the next process.

In the client, type a prompt to start a trajectory. `/resume` lists past
conversations: `↑`/`↓` to select, `enter` to open. Inside a transcript, type to
send another message into that same conversation; your message runs as a fresh
context in the existing trajectory. `/new` abandons the open transcript: the
next prompt starts a fresh trajectory.

`pnpm key` with no command prints its own usage — it is the source of
truth for the CLI. The host reads `.env` from the working directory; a
missing file is fine until a command needs a model.

## Check

```bash
pnpm check   # Biome: format + lint, then tsc
pnpm fix     # apply Biome's safe fixes and formatting
```
