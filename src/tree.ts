// The tree picker: the conversation's entries newest-first, each an inclusive fork cutoff — type
// to narrow, enter picks the entry to fork at, escape leaves.

import { contentText, type Message, type ToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TUI } from "@earendil-works/pi-tui";
import { FilterList } from "./filter-list.ts";
import { shortenHome } from "./footer.ts";
import { firstString } from "./trajectory.ts";

/** What one entry shows, in the shape SelectList draws. */
export type TreeRow = { readonly label: string; readonly description?: string };

const keyOf = (entry: EntryRecord): string => String(entry.id);

/** The entry's message of `role`, the one its kind promises. */
function ofRole<R extends Message["role"]>(
  entry: EntryRecord,
  role: R,
): Extract<Message, { role: R }> | undefined {
  return entry.model?.find(
    (message): message is Extract<Message, { role: R }> => message.role === role,
  );
}

/** Every run of whitespace one space: a single line, its length left to the list's truncation. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The entry's message text of `role` on one line, empty without such a message. */
const textOf = (entry: EntryRecord, role: "user" | "system"): string =>
  oneLine(contentText(ofRole(entry, role)?.content ?? ""));

/** `kind · preview`, or the bare kind when the entry shows nothing of its own. */
function textRow(kind: string, text: string): TreeRow {
  return { label: text === "" ? kind : `${kind} · ${text}` };
}

/** `bash pnpm test`: a call named by the argument that identifies it. */
function callLabel(call: ToolCall): string {
  const first = firstString(call.arguments);
  return first === undefined ? call.name : `${call.name} ${oneLine(shortenHome(first))}`;
}

/** The row an entry gets as a fork cutoff. */
export function row(entry: EntryRecord): TreeRow {
  switch (entry.kind) {
    case "pi.assistant": {
      const message = ofRole(entry, "assistant");
      if (message === undefined) return { label: "assistant" };
      const description = message.model === "" ? undefined : `${message.provider}/${message.model}`;
      const text = oneLine(contentText(message.content) || message.errorMessage || "");
      if (text !== "") return { label: `assistant · ${text}`, description };
      const call = message.content.find((block): block is ToolCall => block.type === "toolCall");
      return {
        label: call === undefined ? "assistant" : `tool call · ${callLabel(call)}`,
        description,
      };
    }
    case "pi.tool-result": {
      const message = ofRole(entry, "toolResult");
      if (message === undefined) return { label: "tool result" };
      const output = oneLine(contentText(message.content));
      return {
        label: `tool result · ${message.toolName}${message.isError ? " (error)" : ""}`,
        description: output === "" ? undefined : output,
      };
    }
    case "pi.user":
      return textRow("user", textOf(entry, "user"));
    case "pi.compaction":
      return textRow("compaction", textOf(entry, "user"));
    case "pi.reset":
      return textRow("reset", textOf(entry, "user"));
    case "pi.system":
      return textRow("system", textOf(entry, "system"));
    default:
      return textRow(entry.kind, oneLine(contentText(entry.model?.[0]?.content ?? "")));
  }
}

/** Everything a query can hit: the whole row, no hidden text. */
export function searchText(entry: EntryRecord): string {
  const { label, description } = row(entry);
  return description === undefined ? label : `${label} ${description}`;
}

/** The `/tree` overlay: the conversation's entries newest-first, the newest selected. */
export function treePicker(
  tui: TUI,
  entries: readonly EntryRecord[],
  onSelect: (entry: EntryRecord) => void,
  onCancel: () => void,
): FilterList<EntryRecord> {
  const list = new FilterList(tui, {
    keyOf,
    item: row,
    search: searchText,
    empty: (query) => (query === "" ? "no entries to fork from" : "no matching entries"),
    placeholder: "type to narrow",
    // The filter and its spacer take two rows; leave one for the list's scroll indicator.
    maxVisible: Math.max(1, tui.terminal.rows - 3),
    onSelect,
    onCancel,
  });
  // Entry ids rise with the conversation, so descending is newest-first; the newest is selected.
  const newestFirst = [...entries].sort((a, b) => b.id - a.id);
  list.select(newestFirst[0] === undefined ? undefined : keyOf(newestFirst[0]));
  list.rebuild(newestFirst);
  return list;
}
