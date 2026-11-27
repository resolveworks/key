# Recall

Key keeps every conversation in one SQLite file, `$KEY_DATA_DIR/session.sqlite`, mounted read-only
into this sandbox. It holds a row per entry (a user turn, an assistant turn, a tool result), the
transcript itself a JSON blob in `record`:

```
entries(id, conversation_id, head, commit_seq, record)     record.kind, record.model
conversations(id, owner_conversation_id, owner_task_id, record)
```

Entry **ids are the coordinates**, where past pi sessions had line numbers. Never read a `record`
raw — it is kilobytes of JSON, tool output and prompt included. Render it with `show.mjs`, beside
this guide: give the tool call the absolute path, which is this guide's own path with `RECALL.md`
replaced by `show.mjs`. The snippets below say `show.mjs` for that copy.

`show.mjs` only assembles and renders. Finding is SQL, wrapped as `search`:

## Find conversations

```bash
node …/show.mjs search drop schema        # several terms vote: most hits first
node …/show.mjs search webview plan -n 5  # the five best conversations
```

Each group is `#id  opening prompt  N hits  term n, …` followed by one rendered row per hit, so a
hit shows the words that matched.

## List conversations

```bash
node …/show.mjs --titles        # the newest 25
node …/show.mjs --titles -n 100
```

Each line is `#id  opening prompt`. The newest sit at the bottom, so a conversation prints under
the one it came from, indented: a fork carries its ancestor's opening prompt. Ids rise globally, so
the list carries the order and `show` and `search` rows carry the timestamps.

## Read a conversation

```bash
node …/show.mjs 42            # dialogue: user and assistant text, thinking, tool calls
node …/show.mjs 42 --user     # digest: only what the human asked
node …/show.mjs 42 --full     # + tool results and the system prompt
```

Rows are `MM-DD HH:MM  id  role  text`, local time, clipped. The header names the conversation and
where it sits: `#51 · fork of #42 at entry 88`, `#77 · child of #42`.

## From a hit to readable context

```bash
node …/show.mjs search 'drop schema'             # which conversations, and where
node …/show.mjs 42 88,92-97                      # those entries, by id
node …/show.mjs search 'drop schema' | node …/show.mjs 42 -   # or read the ids out of piped rows
node …/show.mjs 42 --full                        # …with the tool output around them
```

Naming entries renders them losslessly: tool results and the system prompt come along, which the
dialogue view leaves out.

## Typical flows

- _"When or where did we do X?"_ → `search X` → `42 88,92-97`.
- _"What did we decide about X?"_ → `search X` → `42 --user` to skim the asks → `42` for the
  dialogue around the decision.
- _"Look at our last conversation"_ → `--titles -n 3` → the last id.

## Cascades and forks

A cascade's children are its delegations and researchers, each a conversation of its own: `child of
#P` in the header, indented under `#P` in `--titles`. A fork keeps no copy of its ancestor, so
`show` walks the fork chain and prints the whole inherited history, root first, then the fork's own
turns.

## Your own queries

Past `--titles`, `show`, and `search`, the store is SQL. `record.kind` is one of `pi.user`,
`pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, or `pi.compaction`; messages live in
`record.model`, each with an epoch-ms `timestamp`. A fork names its parent in the conversation's
`record` (`{"id":N,"parent":{"conversationId":P,"at":E}}`); the columns are the cascade owner edge.
`tasks`, `submissions`, and `documents` are key's bookkeeping and hold no transcript.

A conversation's transcript is its fork chain: walk `parent` to the root, cutting each segment at
`min(parent.at)`, and read the segments root to leaf. Entry ids rise globally, so the result is
already ordered.

```bash
node -e 'const {DatabaseSync} = require("node:sqlite");
const db = new DatabaseSync(process.env.KEY_DATA_DIR + "/session.sqlite", { readOnly: true });
console.log(db.prepare("SELECT count(*) AS entries FROM entries").get().entries)'
```

Notes: `$KEY_DATA_DIR` is read-only here — SQLite's WAL serves this reader while the host writes, so
replies and edits still go through key. Ids rise globally, so both lists and transcripts are in
creation order; ids in `--titles` are conversations, ids in rows are entries, and the two do not mix.
