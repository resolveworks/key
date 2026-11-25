#!/usr/bin/env node
// session-history — read key's SQLite store directly and render it: list conversations, show one
// transcript, search every entry. Finding is SQL; this file only assembles and renders.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = process.env.KEY_DATA_DIR;
if (directory === undefined)
  throw new Error("KEY_DATA_DIR is unset: the host sets it; is key running?");
const file = join(directory, "session.sqlite");
if (!existsSync(file))
  throw new Error(`${file} does not exist: the host sets KEY_DATA_DIR; is key running?`);

/** Entries are coordinates: clip long prose the way recall does, so a row stays one line. */
function clip(text, limit) {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (one.length <= limit) return one;
  const head = Math.floor(limit * 0.7);
  return `${one.slice(0, head).trimEnd()} [...] ${one.slice(-(limit - head - 5)).trimStart()}`;
}

/** A message's text: a string, or the text blocks of a content array. */
function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
}

/** The argument a call is best identified by: a shell command, a path, a pattern, else its first string. */
function firstString(args) {
  for (const key of ["command", "path", "pattern"]) {
    const value = args?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const values = Object.values(args ?? {});
  return values.find((value) => typeof value === "string" && value !== "") ?? "";
}

/** Local `MM-DD HH:MM`, the row's left edge. */
function stamp(ms) {
  if (typeof ms !== "number") return " ".repeat(11);
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const db = new DatabaseSync(file, { readOnly: true });

const conversationRow = db.prepare(
  "SELECT id, owner_conversation_id, record FROM conversations ORDER BY id DESC",
);
const newestConversations = db.prepare("SELECT id FROM conversations ORDER BY id DESC LIMIT ?");
const entryOf = db.prepare("SELECT record FROM entries WHERE id = ?");
const firstEntry = db.prepare(
  "SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC LIMIT 1",
);
const segment = db.prepare(
  "SELECT record FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id ASC",
);

/** Every conversation by id: its owner hop and its stored record (a fork names its parent there). */
const conversations = new Map(
  conversationRow
    .all()
    .map(({ id, owner_conversation_id, record }) => [
      id,
      { id, owner: owner_conversation_id, record: JSON.parse(record) },
    ]),
);

function conversation(id) {
  const found = conversations.get(id);
  if (found === undefined) throw new Error(`no conversation #${id}`);
  return found;
}

/** The conversation one fork hop up, unset at a root. */
function parentOf(known) {
  const parent = known.record.parent;
  return parent === undefined ? undefined : conversation(parent.conversationId);
}

/** The conversation one lineage hop up: a fork's parent, else the task that owns it. */
function upOf(known) {
  const parent = parentOf(known);
  if (parent !== undefined) return parent;
  return known.owner === null ? undefined : conversation(known.owner);
}

/** How far below a root the conversation sits: owner and fork hops both nest it. */
function depth(known) {
  let hops = 0;
  for (let at = upOf(known); at !== undefined; at = upOf(at)) hops++;
  return hops;
}

/** A fork opens on the conversation it came from, so its label is that ancestor's first prompt. */
function label(known) {
  let root = known;
  for (let parent = parentOf(root); parent !== undefined; parent = parentOf(parent)) root = parent;
  const row = firstEntry.get(root.id);
  if (row === undefined) return "";
  const message = JSON.parse(row.record).model?.[0];
  return message?.role === "user" ? clip(textOf(message.content), 100) : "";
}

/** A conversation's transcript: the fork chain's segments, each cut at its fork point, root first. */
function transcript(known) {
  const segments = [];
  let upper = Number.MAX_SAFE_INTEGER;
  for (let at = known; ; ) {
    segments.push({ id: at.id, upper });
    const parent = at.record.parent;
    if (parent === undefined) break;
    upper = Math.min(upper, parent.at);
    at = conversation(parent.conversationId);
  }
  // Entry ids rise globally, so the root-to-leaf concatenation is already in conversation order.
  return segments
    .reverse()
    .flatMap(({ id, upper }) => segment.all(id, upper).map(({ record }) => JSON.parse(record)));
}

/** One entry's rows: `MM-DD HH:MM  %6d  role  clipped text`, recall's shape. */
function rows(entry, options = {}) {
  const at = stamp(entry.model?.[0]?.timestamp);
  const lines = [];
  const push = (role, text) => {
    if (text === "") return;
    if (options.user === true && role !== "user") return;
    lines.push(`${at}  ${String(entry.id).padStart(6)}  ${role.padEnd(9)}  ${text}`);
  };
  switch (entry.kind) {
    case "pi.user":
      for (const message of entry.model ?? [])
        if (message.role === "user") push("user", clip(textOf(message.content), 2000));
      break;
    case "pi.assistant":
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
          if (block.type === "text") push("assistant", clip(block.text, 2000));
          else if (block.type === "thinking") push("thinking", clip(block.thinking, 2000));
          else if (block.type === "toolCall")
            push("tool", clip(`${block.name}: ${firstString(block.arguments)}`, 200));
        }
      }
      break;
    case "pi.tool-result":
      if (options.full !== true) break;
      for (const message of entry.model ?? [])
        if (message.role === "toolResult")
          push(
            "result",
            clip(
              `${message.toolName}${message.isError === true ? " (error)" : ""} ${textOf(message.content)}`,
              1500,
            ),
          );
      break;
    case "pi.system":
      if (options.full !== true) break;
      for (const message of entry.model ?? [])
        push(
          "system",
          clip(textOf(message.content) || Object.keys(message.sections ?? {}).join(" "), 200),
        );
      break;
    case "pi.reset":
      push("reset", "── context reset ──");
      break;
    case "pi.compaction":
      push("compact", "── compacted ──");
      break;
  }
  return lines;
}

/** `88,92-97` -> the entry ids it names. */
function parseSpec(spec) {
  const ids = new Set();
  for (const part of spec.split(",")) {
    const [from, to] = part.split("-");
    if (to === undefined) ids.add(Number(from));
    else for (let id = Number(from); id <= Number(to); id++) ids.add(id);
  }
  return ids;
}

/** `#14 · fork of #3 at entry 13`: the conversation and how it hangs off the one before it. */
function ancestry(known) {
  const parts = [`#${known.id}`];
  const parent = known.record.parent;
  if (parent !== undefined) parts.push(`fork of #${parent.conversationId} at entry ${parent.at}`);
  if (known.owner !== null) parts.push(`child of #${known.owner}`);
  return parts.join(" · ");
}

/** The newest conversations, oldest first, so a fork or a cascade child prints under what it came from. */
function list(limit) {
  for (const { id } of newestConversations.all(limit).reverse()) {
    const known = conversation(id);
    const prompt = label(known);
    console.log(`${String(id).padStart(4)}  ${"  ".repeat(depth(known))}${prompt}`);
  }
}

function show(id, options) {
  const known = conversation(id);
  const wanted = options.spec === undefined ? undefined : parseSpec(options.spec);
  console.log(ancestry(known));
  for (const entry of transcript(known)) {
    if (wanted !== undefined && !wanted.has(entry.id)) continue;
    for (const line of rows(entry, options)) console.log(line);
  }
}

/** Per-term counts, conversations ranked by total hits: recall's multi-term vote. */
function search(terms, limit) {
  const matches = db.prepare(
    "SELECT conversation_id, id FROM entries WHERE record LIKE '%' || ? || '%'",
  );
  const found = new Map();
  for (const term of terms) {
    for (const { conversation_id, id } of matches.all(term)) {
      const byTerm = found.get(conversation_id) ?? new Map();
      byTerm.set(term, [...(byTerm.get(term) ?? []), id]);
      found.set(conversation_id, byTerm);
    }
  }
  const ranked = [...found]
    .map(([id, byTerm]) => ({
      id,
      byTerm,
      total: [...byTerm.values()].reduce((sum, ids) => sum + ids.length, 0),
    }))
    .sort((left, right) => right.total - left.total || right.id - left.id);
  if (ranked.length === 0) return console.log("no hits");
  for (const { id, byTerm, total } of ranked.slice(0, limit)) {
    const counts = terms.map((term) => `${term} ${byTerm.get(term)?.length ?? 0}`).join(", ");
    console.log(`#${id}  ${label(conversation(id))}  ${total} hits  ${counts}`);
    const ids = [...new Set([...byTerm.values()].flat())].sort((left, right) => left - right);
    for (const hit of ids)
      for (const line of rows(JSON.parse(entryOf.get(hit).record))) console.log(line);
  }
}

const USAGE = `history.mjs list [--limit N]                     newest, oldest first, nested by lineage
history.mjs show <conversation> [--full] [--user] [spec]   one transcript; spec is 88,92-97
history.mjs search <terms...> [--limit N]          conversations ranked by total hits`;

const [command, ...args] = process.argv.slice(2);
const options = { full: false, user: false, limit: 25, spec: undefined };
const positional = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--full") options.full = true;
  else if (arg === "--user") options.user = true;
  else if (arg === "--limit") options.limit = Number(args[++index]);
  else positional.push(arg);
}

switch (command) {
  case "list":
    list(options.limit);
    break;
  case "show":
    options.spec = positional[1];
    show(Number(positional[0]), options);
    break;
  case "search":
    search(positional, options.limit);
    break;
  default:
    console.log(USAGE);
}
