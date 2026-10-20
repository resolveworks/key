// A transcript as pi draws one: the human's words in a box, assistant text as markdown, thinking in
// italics, and every tool call its own box whose background says how the call is going.

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  EntryRecord,
  LiveState,
  ToolSlot,
} from "@earendil-works/pi-durable";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { shortenHome } from "./footer.ts";
import { diff, markdown, style } from "./theme.ts";

/** Collapsed tool output shows this many lines; pi's preview depth for a shell. */
const PREVIEW_LINES = 5;

/** A view as the components that draw it: settled entries, then the live generation and its tools. */
export function transcript(view: ConversationView): readonly Component[] {
  const blocks: Component[] = [];
  const calls = callIndex(view);
  for (const entry of view.entries) blocks.push(...entryBlocks(entry, calls));
  const live = view.docs["pi.live"] as LiveState | undefined;
  if (live?.generation?.message !== undefined) {
    blocks.push(...assistantBlocks(live.generation.message as AssistantMessage, calls, true));
  }
  for (const slot of live?.tools ?? []) blocks.push(toolBox(slot));
  if (live?.generation === undefined && (live?.tools ?? []).length === 0 && blocks.length === 0) {
    blocks.push(new Text(style.dim("empty transcript"), 1, 0));
  }
  // The transcript never ends flush against the prompt.
  return [...layout(blocks), new Spacer(1)];
}

/**
 * Every tool call in the conversation, by call ID. A result records the call it answers, but the
 * arguments live on the call, which is how a settled box gets its title.
 */
type Calls = ReadonlyMap<string, { readonly arguments: unknown }>;

function callIndex(view: ConversationView): Calls {
  const found = new Map<string, { readonly arguments: unknown }>();
  for (const message of messagesOf(view)) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") found.set(block.id, { arguments: block.arguments });
    }
  }
  return found;
}

function messagesOf(view: ConversationView): readonly Message[] {
  return view.entries.flatMap((entry) =>
    entry.kind === "pi.reset" || entry.kind === "pi.compaction" ? [] : (entry.model ?? []),
  );
}

/** pi separates turns with a blank line; each component supplies its own gutter, so nothing is inset here. */
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

/** The human's turn: a full-width box, the way pi draws a user message. */
function userBlocks(message: Message): readonly Component[] {
  const text = message.role === "user" ? textOf(message.content).trim() : "";
  if (text === "") return [];
  return [new Markdown(text, 1, 1, markdown, { color: style.text, bgColor: style.userBg })];
}

/** Assistant turns: text as markdown, thinking in italics above it. Tool calls get no box of their own. */
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
  if (streaming && message.content.length === 0) {
    blocks.push(new Text(style.dim("…"), 1, 0));
  }
  // A live call has no result yet: draw it in its running box so the transcript shows the work.
  for (const block of message.content) {
    if (block.type !== "toolCall" || calls.has(block.id)) continue;
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

/** A settled call: its box, with the diff it made or the tail of what it printed beneath the title. */
function toolResultBox(message: ToolResultMessage, calls: Calls): Component {
  const call = calls.get(message.toolCallId);
  return toolBox(
    {
      name: message.toolName,
      status: "done",
      output: textOf(message.content),
      ...(message.details === undefined ? {} : { details: message.details }),
      ...(call === undefined ? {} : { args: call.arguments }),
    },
    message.isError,
  );
}

/**
 * What a box needs to know about a call: whether it is still running, its title, and what it printed.
 * `details` stays `unknown`, because the live slot and the settled message come from different copies of
 * the JSON types.
 */
type Call = {
  readonly status: ToolSlot["status"];
  readonly name: string;
  readonly args?: unknown;
  readonly output?: string;
  readonly details?: unknown;
};

/** A tool call in pi's shape: a titled box colored by outcome, holding the result's first lines. */
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

/** `name argument`, the way pi titles a call: the identifying argument, dimmed, on one line. */
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
function firstString(args: Record<string, unknown>): string | undefined {
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

/** pi's diff colors, keeping the line numbers durable's diff carries. */
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

function note(text: string): Component {
  return new Text(style.dim(text), 1, 0);
}

function textOf(
  content: string | readonly { readonly type: string; readonly text?: string }[],
): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n");
}
