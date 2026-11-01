# Key

Key is my personal harness for coding agents: a durable host with clients for
starting, steering, and observing work. It is a serious playground—something
that evolves with me as I learn how I want to direct agents.

## Information flows forward

Work happens in conversations. A conversation can `fork` named children, each
starting immediately in a fresh context and its own git worktree. The forking
run does not wait for them and never receives their results through a return
value. There is no call/return.

When a run that forked children finishes, a fresh successor takes over. It
waits for those children to settle, receives their branch names and
conversation ids, and may fork again. This continues until a run forks nothing.

The resulting cascade is a chain of fresh contexts with branches of work coming
off each step. Information enters new contexts instead of accumulating in one
ever-growing conversation.

## Questioning the past

Fresh contexts do not make the past inaccessible. Every context can use `ask`
to question a settled conversation that came before it.

`ask` reads that conversation's own frozen context and answers without
appending to it. A successor can therefore query its predecessor and the
children it joins, asking one question or many, without carrying their entire
transcripts forward.

These are two sides of the same idea: information falls forward through fresh
contexts, and every context can question the past.

## One host, many clients

The host owns the durable sessions and the work. Clients are interchangeable
ways into it. The terminal client is the one I use now; the same architecture
leaves room for an Android client and automated clients that observe work or
propose new work.

The implementation will keep changing. The direction is a harness that remains
mine to optimize and direct.
