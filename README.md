# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
A proof of concept, not a product.

Information only flows forward; there is no call/return anywhere. The
canonical design is `~/Documents/Key/design_initial.md`.

## Run

```bash
pnpm install
export KEY_MODEL="deepseek/deepseek-flash"
node src/main.ts
```

Requires Node ≥ 23 (TypeScript type stripping).
