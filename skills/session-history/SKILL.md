---

name: session-history
description: Search and review past key conversations in the session store. Use when the user asks what was discussed, decided, or tried before in key — "what did we do about X", "find the conversation where...", "when did we run Y", "look at our last conversation", "what were we working on".
---

# Session history

Key keeps its whole session in one SQLite file, `$KEY_DATA_DIR/session.sqlite`: a row per entry,
the transcript as a JSON blob. Entries are the coordinates, like line numbers — read them by id.
Never read a record raw; render with `history.mjs`, next to this file. The snippets below say
`history.mjs` for that copy: give the tool call its absolute path.

```bash
node history.mjs list          # newest first, nested by lineage
node history.mjs show 42       # one conversation's transcript
```

## List

```bash
node history.mjs list                # 25 newest conversations
node history.mjs list --limit 100
```

Each line is the `id` and the conversation's opening prompt.

## Read

```bash
node history.mjs show 42                     # dialogue: user and assistant text, thinking, tool calls
node history.mjs show 42 --user              # digest: only what the human asked
node history.mjs show 42 --full              # plus tool results and the system prompt
node history.mjs show 42 88,92-97            # only these entries, by id
```

Rows are `MM-DD HH:MM  id  role  text`, local time, clipped. The header names the conversation and
where it sits: `#51 · fork of #42 at entry 88`, `#77 · child of #42`.

## Search

```bash
node history.mjs search drop schema          # several terms vote: most hits first
node history.mjs search webview plan --limit 5
```

Every conversation with a hit prints its id, opening prompt, total hits and per-term counts, then
one rendered row per hit.

The search runs over the stored records, the system prompt included, so a common word hits that
entry in every conversation; `show <id> --full` renders it as `system`.

## From a hit to context

```bash
node history.mjs search 'drop schema'        # which conversations, and where
node history.mjs show 42 88,92-97            # the matched entries
node history.mjs show 42 --full              # …with the tool output around them
```

## Cascades and forks

A cascade's children are the delegations and researchers, each a conversation of its own: a
`child of #P` in the header, indented under `#P` in the list.

A fork keeps no copy of its ancestor. `show` walks the fork chain and prints the whole inherited
history, root first, then the fork's own turns — so a fork's transcript starts with the words it
inherited. Its line in the list carries the ancestor's opening prompt, nested under it.

## Custom queries

The store is mounted read-only into this sandbox as `$KEY_DATA_DIR`, so SQLite reads it while the
host writes. `list`, `show`, and `search` cover most questions; the rest is your own query with
`node:sqlite`:

- `conversations(id, owner_conversation_id, owner_task_id, record)` — `record` is `{"id":N}` or
  `{"id":N,"parent":{"conversationId":P,"at":E}}`; the columns are the owner edge.
- `entries(id, conversation_id, head, commit_seq, record)` — `record.kind` is `pi.user`,
  `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, or `pi.compaction`; the messages are in
  `record.model`, each with an epoch-ms `timestamp`.
- `tasks`, `submissions`, `documents` — durable's own bookkeeping; documents hold no transcript.

A conversation's transcript is its fork chain: walk `parent` to the root, cutting each segment at
`min(parent.at)`, and read the segments root to leaf. Entry ids rise globally, so the result is
already ordered.

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.KEY_DATA_DIR+"/session.sqlite",{readOnly:true});
console.log(db.prepare("SELECT count(*) FROM entries").get())'
```
