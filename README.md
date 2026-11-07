# Key

Key is my personal harness for coding agents: a durable host and a terminal
client for starting, steering, and observing work. It is a serious playground,
built to evolve with me as I learn how I want to direct agents.

## The idea

Key organizes work as cascades of fresh contexts. A conversation can delegate
independent implementation to workers or start researchers to investigate
questions. When the conversation finishes, a fresh successor takes over, waits
for those children to settle, receives their results, and decides what happens
next. The cascade continues for as long as it keeps starting children.

Information flows forward rather than accumulating in one ever-growing
conversation. A successor starts with the work and findings before it, not a
copy of every transcript.

The past remains available without becoming baggage. Earlier conversations
stay frozen and can be questioned when their knowledge is needed. Their answers
inform the present without rewriting or extending the past.

These are two sides of the same idea: fresh contexts carry work forward, and
the past remains something they can consult.

## Host and clients

The host owns durable sessions and the work running through them. Clients are
ways into that host, not owners of the work themselves. The terminal is the
client I use now; the same architecture leaves room for mobile and automated
clients, including clients that propose new work.

The implementation will keep changing. The direction is a harness that remains
mine to optimize and direct.

## Usage

Key needs Node, pnpm, bubblewrap, and a built checkout of
[pi](../pi) beside this repository.

```sh
pnpm install
pnpm build:env
pnpm serve
```

In another terminal, connect the client:

```sh
pnpm client
```

## Development

```sh
pnpm check
pnpm test
```

Behavior tests live under `tests/`. Git hooks live in `.githooks`:

```sh
git config core.hooksPath .githooks
```
