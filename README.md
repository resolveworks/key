# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
A proof of concept, not a product.

Information only flows forward; there is no call/return anywhere. The
canonical design is `~/Documents/Key/design_initial.md`.

## Run

```bash
pnpm install
```

`.env` in the working directory is required; it supplies the worker model
and its provider key:

```ini
KEY_MODEL=deepseek/deepseek-flash
DEEPSEEK_API_KEY=...
```

```bash
node src/main.ts
```

Requires Node ≥ 23 (TypeScript type stripping).
