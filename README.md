# Key

**Cascading contexts.** Information only flows forward. There is no call/return
anywhere.

The implementation may change. The idea below does not.

## Core idea

Every agent invocation is a **fresh context**. A context runs once, may fork
child contexts, and then ends. It never waits for a child, never resumes, and
never receives a child's result.

When a context forks, it mints:

- a fresh conversation for each child context, owned by the context that forked
  it, and therefore by that context's conversation;
- a fresh successor context in its own conversation, created to run once those
  children settle.

The successor starts with the forking context's last message and the children's
results. It is not the forking context continuing. It is a new context.

If the successor forks again, the same thing happens: it forks children and mints
a new successor that will run when they settle. That is the loop. The loop ends
when a context forks nothing.

A **conversation** is one cascade loop: a kickoff context followed by a chain of
fresh successor contexts. It can fork and join many times. The first context is
the human kickoff; every later context is a loop iteration.

Each forked child is its own branch, with its own conversation and its own loop.
A child's work happens in its own conversation; only its settled result crosses
into the parent's next fresh context.

```text
conversation C

  A          kickoff context; forks children
  A'         fresh successor: joins A's children; may fork more
  A''        fresh successor: joins the children forked by A'
  ...        until a context forks nothing
```

Information only ever enters a fresh context. Nothing returns to the context
that forked it.

Working agreements live in `AGENTS.md`.
