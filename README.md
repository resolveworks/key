# Key

A spike: **cascading contexts** — a fork/join agent system on
[`@earendil-works/pi-durable`](../pi/packages/durable). A proof of concept,
not a product.

Information only flows forward; there is no call/return anywhere. The
canonical design is `~/Documents/Key/design_initial.md`.

## Run

```bash
pnpm install
export KEY_MODEL="deepseek/deepseek-flash"
node --conditions=source src/main.ts
```

Requires Node ≥ 23 and the pi repo checked out at `~/Projects/pi`
(dependencies are `file:` links into it). Follow `demo.md` for the
fork → join → human walkthrough, including the kill-9 restart.
