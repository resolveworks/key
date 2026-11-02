// A transcript: the human's words in a box, assistant text as markdown, thinking in italics,
// and every tool call its own box whose background says how the call is going.

import {
  type AssistantMessage,
  contentText,
  type Message,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, TranscriptView } from "@earendil-works/pi-durable";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { shortenHome } from "./footer.ts";
import { diff, markdown, style } from "./theme.ts";

/** Collapsed tool output shows this many lines. */
const PREVIEW_LINES = 5;

/** A view as components: settled entries, then the live generation still being written. */
export function transcript(view: TranscriptView): readonly Component[] {
  const blocks: Component[] = [];
  const calls = callIndex(view);
  for (const item of view.items) {
    if (item.kind === "entry") blocks.push(...entryBlocks(item.entry, calls));
    else {
      blocks.push(
        note(item.kind === "earlier" ? "── loading earlier ──" : "── loading missed entries ──"),
      );
    }
  }
  const live = view.docs["pi.live"] as LiveState | undefined;
  // A running call is an entry already: durable commits the tool-calling answer before its round
  // starts. Only a generation still being written lives in the document.
  if (live?.generation?.message !== undefined) {
    blocks.push(...assistantBlocks(live.generation.message as AssistantMessage, calls, true));
  }
  if (blocks.length === 0) blocks.push(new Text(style.dim("empty transcript"), 1, 0));
  // The transcript never ends flush against the prompt.
  return [...layout(blocks), new Spacer(1)];
}

/** A running call has the first and not the second, which is how its box knows it is still going. */
type Calls = {
  readonly arguments: ReadonlyMap<string, unknown>;
  readonly answered: ReadonlySet<string>;
};

function callIndex(view: TranscriptView): Calls {
  const args = new Map<string, unknown>();
  const answered = new Set<string>();
  for (const message of messagesOf(view)) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") args.set(block.id, block.arguments);
      }
    } else if (message.role === "toolResult") {
      answered.add(message.toolCallId);
    }
  }
  return { arguments: args, answered };
}

function messagesOf(view: TranscriptView): readonly Message[] {
  return view.items.flatMap((item) => {
    if (item.kind !== "entry") return [];
    const entry = item.entry;
    return entry.kind === "pi.reset" || entry.kind === "pi.compaction" ? [] : (entry.model ?? []);
  });
}

/** Turns separate with a blank line; each component supplies its own gutter, so nothing is inset. */
function layout(blocks: readonly Component[]): readonly Component[] {
  const rows: Component[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) rows.push(new Spacer(1));
    rows.push(block);
  });
  return rows;
}

function entryBlocks(entry: EntryRecord, calls: Calls): readonly Component[] {
  switch (entry.kind) {
    case "pi.user":
      return (entry.model ?? []).flatMap((message) =>
        message.role === "user" ? userBlocks(message) : [],
      );
    case "pi.assistant":
      return (entry.model ?? []).flatMap((message) =>
        message.role === "assistant" ? assistantBlocks(message, calls) : [],
      );
    case "pi.tool-result":
      return (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult" ? [toolResultBox(message, calls)] : [],
      );
    case "pi.reset":
      return [note("── context reset ──")];
    case "pi.compaction":
      return [note("── compacted ──")];
    default:
      return [];
  }
}

/** The human's turn: a full-width box. */
function userBlocks(message: Message): readonly Component[] {
  const text = message.role === "user" ? contentText(message.content).trim() : "";
  if (text === "") return [];
  return [new Markdown(text, 1, 1, markdown, { color: style.text, bgColor: style.userBg })];
}

/** Assistant turns: text as markdown, thinking in italics above it. Tool calls get no box of
 * their own — settled ones come as tool-result entries, running ones below. */
function assistantBlocks(
  message: AssistantMessage,
  calls: Calls,
  streaming = false,
): readonly Component[] {
  const blocks: Component[] = [];
  let thinking: string[] = [];
  const flush = (): void => {
    if (thinking.length === 0) return;
    blocks.push(
      new Markdown(thinking.join("\n\n"), 1, 0, markdown, {
        color: style.thinking,
        italic: true,
      }),
    );
    thinking = [];
  };
  for (const block of message.content) {
    if (block.type === "thinking") {
      if (block.thinking.trim() !== "") thinking.push(block.thinking.trim());
    } else if (block.type === "text") {
      flush();
      if (block.text.trim() !== "") blocks.push(new Markdown(block.text.trim(), 1, 0, markdown));
    }
  }
  flush();
  // A generation that has content but nothing to show yet is still working.
  if (streaming && blocks.length === 0) blocks.push(new Text(style.dim("…"), 1, 0));
  // A call whose result has not landed yet keeps its running box, args and all.
  for (const block of message.content) {
    if (block.type !== "toolCall" || calls.answered.has(block.id)) continue;
    blocks.push(toolBox({ name: block.name, status: "running", args: block.arguments }));
  }
  const failure = stopReasonText(message);
  if (failure !== "") blocks.push(new Text(style.error(failure), 1, 0));
  return blocks;
}

function stopReasonText(message: AssistantMessage): string {
  switch (message.stopReason) {
    case "error":
      return `Error: ${message.errorMessage ?? "Unknown error"}`;
    case "aborted":
      return message.errorMessage ?? "Operation aborted";
    case "length":
      return "Response was truncated before completion.";
    default:
      return "";
  }
}

/** A settled call's box. */
function toolResultBox(message: ToolResultMessage, calls: Calls): Component {
  const call = calls.arguments.get(message.toolCallId);
  return toolBox(
    {
      name: message.toolName,
      status: "done",
      output: contentText(message.content),
      ...(message.details === undefined ? {} : { details: message.details }),
      ...(call === undefined ? {} : { args: call }),
    },
    message.isError,
  );
}

/** `details` stays `unknown`: the live slot and the settled message come from different copies of
 * the JSON types. */
type Call = {
  readonly status: "done" | "running";
  readonly name: string;
  readonly args?: unknown;
  readonly output?: string;
  readonly details?: unknown;
};

/** A tool call: a titled box colored by outcome. */
function toolBox(slot: Call, isError = false): Component {
  const background =
    slot.status !== "done"
      ? style.toolBg.pending
      : isError
        ? style.toolBg.error
        : style.toolBg.success;
  const box = new Box(1, 1, background);
  box.addChild(new Text(toolTitle(slot.name, slot.args), 0, 0));
  const body = slotBody(slot);
  if (body !== undefined) {
    box.addChild(new Spacer(1));
    box.addChild(new Text(body, 0, 0));
  }
  return box;
}

/** `name argument`: the identifying argument, dimmed. */
function toolTitle(name: string, args: unknown): string {
  const first =
    args !== null && typeof args === "object"
      ? firstString(args as Record<string, unknown>)
      : undefined;
  if (first === undefined) return style.bold(name);
  const oneLine = shortenHome(first).replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine;
  return `${style.bold(name)} ${style.dim(preview)}`;
}

/** The argument a call is best identified by: a shell command, a path, a pattern, else its first string. */
export function firstString(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "path", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return Object.values(args).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/** What the call produced: a colored diff when it edited, else the tail of its output. */
function slotBody(slot: Call): string | undefined {
  const details = slot.details as { diff?: unknown } | undefined;
  if (typeof details?.diff === "string") return renderDiff(details.diff);
  const output = slot.output?.trimEnd() ?? "";
  if (output === "") return undefined;
  const lines = output.split("\n");
  const shown = lines.slice(Math.max(0, lines.length - PREVIEW_LINES));
  const hidden = lines.length - shown.length;
  const body = shown.map(style.toolOutput).join("\n");
  const hint = style.muted(`... (${hidden} earlier lines)`);
  return hidden === 0 ? body : `${hint}\n${body}`;
}

/** Diff colors, keeping the line numbers durable's diff carries. */
function renderDiff(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return diff.added(line);
      if (line.startsWith("-")) return diff.removed(line);
      return diff.context(line);
    })
    .join("\n");
}

function note(text: string, paint: (text: string) => string = style.dim): Component {
  return new Text(paint(text), 1, 0);
}
