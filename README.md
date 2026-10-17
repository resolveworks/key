# Key

**Cascading contexts.** Information only flows forward. There is no call/return
anywhere.

The implementation may change. The idea below does not.

## Core idea

Every agent invocation is a **fresh context**. A context runs once, may fork
child contexts, and then ends. It never waits for a child, never resumes, and
never receives a child's result.

When a context forks, it mints:

- a child task for each child context, to run in a fresh conversation of its own;
- a successor task, to run in a fresh conversation of its own once those children
  settle.

The successor starts with the forking context's last message and the children's
results. It is not the forking context continuing. It is a new context.

If the successor forks again, the same thing happens: it forks children and mints
a new successor that will run when they settle. That is the loop. The loop ends
when a context forks nothing.

A **cascade** is one loop: a kickoff context followed by a chain of fresh
successor contexts. It can fork and join many times. The first context is the
human kickoff; every later context is a loop iteration.

Every cascade context runs in a conversation of its own; the cascade never resumes
one. A human message is the one way back in: it starts a fresh context in the open
conversation. Each forked child is its own branch; only its settled result crosses
into the parent's successor.

```text
cascade

  A          kickoff context; forks children
  A'         fresh successor: joins A's children; may fork more
  A''        fresh successor: joins the children forked by A'
  ...        until a context forks nothing
```

Information only ever enters a fresh context. Nothing returns to the context
that forked it.

Working agreements live in `AGENTS.md`.
