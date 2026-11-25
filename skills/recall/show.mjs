#!/usr/bin/env node
// recall — read key's session store: list conversations, render one transcript, search every entry.
// SQL does the finding; this file only assembles and renders.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDirectory = process.env.KEY_DATA_DIR;
if (dataDirectory === undefined)
  throw new Error("KEY_DATA_DIR is unset: the host mounts key's data directory; is key running?");
const file = join(dataDirectory, "session.sqlite");
if (!existsSync(file))
  throw new Error(
    `${file} is missing: KEY_DATA_DIR names the host's data directory; is key running?`,
  );

const USAGE = `show.mjs <conversation> [spec] [--full] [--user]   one transcript; spec is 88,92-97 or - (ids piped in)
show.mjs --titles [-n N]                     the newest conversations, oldest first, nested by lineage
show.mjs search <terms...> [-n N]            conversations ranked by hits, with a row per hit`;

/** Rows are coordinates: clip long prose the way recall does, so an entry stays one line. */
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

/** The argument a call is best identified by: its first string. */
const firstString = (args = {}) =>
  Object.values(args).find((value) => typeof value === "string" && value !== "") ?? "";

/** Local `MM-DD HH:MM`, the row's left edge; blank when the entry carries no timestamp. */
function stamp(timestamp) {
  if (typeof timestamp !== "number") return " ".repeat(11);
  const at = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const db = new DatabaseSync(file, { readOnly: true });

const newest = db.prepare("SELECT id FROM conversations ORDER BY id DESC LIMIT ?");
const entryOf = db.prepare("SELECT id, record FROM entries WHERE id = ?");
const openingPrompt = db.prepare(
  "SELECT record FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user' ORDER BY id ASC LIMIT 1",
);
const segmentOf = db.prepare(
  "SELECT id, record FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id ASC",
);

/** A stored entry: the columns are the coordinates, the record's copy of the id just rides along. */
const entryOfRow = ({ id, record }) => ({ ...JSON.parse(record), id });

/** Every conversation by id: the owner edge is a column, the fork edge lives in the record. */
const conversations = new Map(
  db
    .prepare("SELECT id, owner_conversation_id AS owner, record FROM conversations")
    .all()
    .map(({ id, owner, record }) => [id, { id, owner, record: JSON.parse(record) }]),
);

function conversation(id) {
  const known = conversations.get(id);
  if (known === undefined) throw new Error(`no conversation #${id}`);
  return known;
}

/** One lineage hop up: a fork's parent, else the task that owns it; unset at a root. */
function upOf(known) {
  const { parent } = known.record;
  if (parent !== undefined) return conversation(parent.conversationId);
  return known.owner === null ? undefined : conversation(known.owner);
}

/** How far below a root it sits: fork and owner hops both nest it. */
function depth(known) {
  let hops = 0;
  for (let at = upOf(known); at !== undefined; at = upOf(at)) hops++;
  return hops;
}

/** The words a conversation opens on, which a fork inherits from its ancestor. */
function label(known) {
  let root = known;
  while (root.record.parent !== undefined) root = conversation(root.record.parent.conversationId);
  const row = openingPrompt.get(root.id);
  return row === undefined ? "" : clip(textOf(JSON.parse(row.record).model?.[0]?.content), 100);
}

/** A conversation's transcript: the fork chain's segments, each cut at its fork point, root first. */
function transcript(known) {
  const segments = [];
  let upper = Number.MAX_SAFE_INTEGER;
  for (let at = known; ; ) {
    segments.push({ id: at.id, upper });
    const { parent } = at.record;
    if (parent === undefined) break;
    upper = Math.min(upper, parent.at);
    at = conversation(parent.conversationId);
  }
  // Entry ids rise globally, so the root-to-leaf concatenation is already in conversation order.
  return segments.reverse().flatMap(({ id, upper }) => segmentOf.all(id, upper).map(entryOfRow));
}

/** One entry's rows: `MM-DD HH:MM  id  role  text`, recall's shape, in the entry's own order. */
function rows(entry, options = {}) {
  const wide = options.full === true ? 6000 : 2000;
  const at = stamp(entry.model?.[0]?.timestamp);
  const lines = [];
  const push = (role, text) => {
    if (text === "" || (options.user === true && role !== "user")) return;
    lines.push(`${at}  ${String(entry.id).padStart(6)}  ${role.padEnd(9)}  ${text}`);
  };
  switch (entry.kind) {
    case "pi.user":
      for (const message of entry.model ?? [])
        if (message.role === "user") push("user", clip(textOf(message.content), wide));
      break;
    case "pi.assistant":
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
          if (block.type === "text") push("assistant", clip(block.text, wide));
          else if (block.type === "thinking") push("thinking", clip(block.thinking, wide));
          else if (block.type === "toolCall")
            push("tool", clip(`${block.name}: ${firstString(block.arguments)}`, 200));
        }
      }
      break;
    case "pi.tool-result":
      if (options.full !== true) break;
      for (const message of entry.model ?? []) {
        if (message.role !== "toolResult") continue;
        const error = message.isError === true ? " (error)" : "";
        push("result", clip(`${message.toolName}${error} ${textOf(message.content)}`, 1500));
      }
      break;
    case "pi.system":
      if (options.full !== true) break;
      for (const message of entry.model ?? []) {
        const sections = Object.values(message.sections ?? {}).join(" ");
        const tools = (message.toolsAdded ?? []).map((tool) => tool.name).join(" ");
        push("system", clip(sections || tools, 400));
      }
      break;
    case "pi.reset":
      push("reset", "── context reset ──");
      break;
    case "pi.compaction":
      push("compact", "── compacted ──");
      break;
    // Any other kind is an extension's own display entry: not conversation.
  }
  return lines;
}

/** `88,92-97` -> the entry ids it names. */
function parseSpec(spec) {
  const ids = new Set();
  for (const part of spec.split(",")) {
    const [from, to = from] = part.split("-");
    for (let id = Number(from); id <= Number(to); id++) ids.add(id);
  }
  return ids;
}

/** The ids piped rows name: the column after the timestamp, so `search … | show.mjs ID -` reads them. */
function pipedIds() {
  const rows = [...readFileSync(0, "utf8").matchAll(/^\d\d-\d\d \d\d:\d\d +(\d+) /gm)];
  const ids = new Set(rows.map((row) => Number(row[1])));
  if (ids.size === 0) throw new Error("no entry ids on stdin: pipe search or show rows in");
  return ids;
}

/** `#42 · fork of #3 at entry 17`: the conversation, and how it hangs off the one before it. */
function ancestry(known) {
  const parts = [`#${known.id}`];
  const { parent } = known.record;
  if (parent !== undefined) parts.push(`fork of #${parent.conversationId} at entry ${parent.at}`);
  if (known.owner !== null) parts.push(`child of #${known.owner}`);
  return parts.join(" · ");
}

function show(id, options) {
  const known = conversation(id);
  const { spec } = options;
  const wanted = spec === "-" ? pipedIds() : spec === undefined ? undefined : parseSpec(spec);
  // Naming entries asks for their own words: render them losslessly, tool results included.
  const full = options.full === true || wanted !== undefined;
  console.log(ancestry(known));
  for (const entry of transcript(known)) {
    if (wanted !== undefined && !wanted.has(entry.id)) continue;
    for (const line of rows(entry, { full, user: options.user })) console.log(line);
  }
}

/** The newest conversations, oldest first, so a fork or a cascade child prints under what it came from. */
function titles(limit) {
  for (const { id } of newest.all(limit).reverse())
    console.log(`#${id}  ${"  ".repeat(depth(conversation(id)))}${label(conversation(id))}`);
}

/** Per-term counts, conversations ranked by total hits: recall's multi-term vote over the stored records. */
function search(terms, limit) {
  // Terms are substrings, not patterns: `instr` keeps a URL's `%` or an identifier's `_` literal.
  const matches = db.prepare(
    "SELECT conversation_id, id FROM entries WHERE instr(lower(record), lower(?)) > 0",
  );
  const found = new Map();
  for (const term of terms) {
    for (const { conversation_id: id, id: entry } of matches.all(term)) {
      const byTerm = found.get(id) ?? new Map();
      byTerm.set(term, [...(byTerm.get(term) ?? []), entry]);
      found.set(id, byTerm);
    }
  }
  const ranked = [...found]
    .map(([id, byTerm]) => ({ id, byTerm, total: [...byTerm.values()].flat().length }))
    .sort((left, right) => right.total - left.total || right.id - left.id);
  if (ranked.length === 0) return console.log(`no hits for ${terms.join(" ")}`);
  for (const { id, byTerm, total } of ranked.slice(0, limit)) {
    const counts = terms.map((term) => `${term} ${byTerm.get(term)?.length ?? 0}`).join(", ");
    const counted = `${total} hit${total === 1 ? "" : "s"}`;
    console.log(`#${id}  ${label(conversation(id))}  ${counted}  ${counts}`);
    const hits = [...new Set([...byTerm.values()].flat())].sort((left, right) => left - right);
    for (const hit of hits)
      for (const line of rows(entryOfRow(entryOf.get(hit)), { full: true })) console.log(line);
  }
}

const args = process.argv.slice(2);
const sized = args.indexOf("-n");
// `-n` and its value leave the arguments here, so what remains is flags and positionals.
const limit = sized === -1 ? 25 : Number(args.splice(sized, 2)[1]);
const flags = args.filter((arg) => arg.startsWith("--"));
const positional = args.filter((arg) => arg === "-" || !arg.startsWith("-"));
const options = { full: flags.includes("--full"), user: flags.includes("--user") };

if (flags.includes("--titles")) titles(limit);
else if (positional[0] === "search") search(positional.slice(1), limit);
else if (positional.length === 0) console.log(USAGE);
else show(Number(positional[0]), { ...options, spec: positional[1] });
