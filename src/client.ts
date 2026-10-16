// The client: a dumb terminal. It lists the host's transcripts, shows any of them, and streams the
// running ones. All state lives in the host; this attaches, renders views, and submits prompts back.
import {
	Container,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	SelectList,
	type SelectListTheme,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { Summary } from "./host.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => cyan(text),
	selectedText: (text) => bold(text),
	description: (text) => dim(text),
	scrollInfo: (text) => dim(text),
	noMatch: (text) => dim(text),
};

/** Attach to the host, list its transcripts, and show any of them until interrupted. */
export async function open(base: string): Promise<void> {
	const tui = new TuiAltScreen(new ProcessTerminal());
	const body = new Container();
	const scroll = new ScrollView(body, { follow: "end", primary: true });
	const footer = new Text("", 1, 0);

	let mode: "list" | "transcript" = "list";
	let summaries: readonly Summary[] = [];
	let list = makeList([]);
	let transcript: { stop: () => void } | undefined;

	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, minSize: 1 },
			{ component: footer, basis: "auto", shrink: 1, minSize: 1 },
		]),
	);

	const quit = (): void => {
		transcript?.stop();
		tui.stop({ preserveScreen: false });
		process.exit(0);
	};

	const showList = (): void => {
		mode = "list";
		transcript?.stop();
		transcript = undefined;
		body.clear();
		list = makeList(summaries);
		list.onSelect = (item) => showTranscript(Number(item.value));
		list.onCancel = () => quit();
		body.addChild(list);
		tui.setFocus(list);
		footer.setText(dim("  ↑/↓ select · enter open · ctrl+c quit"));
		tui.requestRender();
	};

	const showTranscript = (id: number): void => {
		mode = "transcript";
		transcript?.stop();
		body.clear();
		body.addChild(new Text(dim("  connecting…"), 1, 0));
		tui.setFocus(null);
		tui.requestRender();
		transcript = watchTranscript(base, id, (view) => {
			body.clear();
			for (const entry of renderView(view)) body.addChild(entry);
			const label = summaries.find((summary) => summary.id === id);
			const running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			footer.setText(dim(`  ${running ? "● streaming" : "○ idle"} · ${label?.label ?? `conversation ${id}`} · esc back`));
			tui.requestRender();
		});
	};

	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			quit();
			return { consume: true };
		}
		if (mode === "transcript" && matchesKey(data, "escape")) {
			showList();
			return { consume: true };
		}
		return undefined;
	});

	showList();
	tui.start();

	for await (const next of stream<readonly Summary[]>(`${base}/api/conversations`)) {
		summaries = next;
		if (mode === "list") showList();
	}
}

/** One selectable transcript. */
function makeList(summaries: readonly Summary[]): SelectList {
	const list = new SelectList(
		summaries.map((summary) => ({
			value: String(summary.id),
			label: `#${summary.id}`,
			description: `${summary.running ? "●" : "○"} ${summary.owner}${summary.label === "" ? "" : ` · ${summary.label}`}`,
		})),
		20,
		selectTheme,
	);
	return list;
}

/** A view's entries as renderable components, live generation and tools last. */
function renderView(view: ConversationView): readonly Text[] {
	const parts: Text[] = [];
	for (const entry of view.entries) parts.push(...renderEntry(entry));
	const live = view.docs["pi.live"] as LiveState | undefined;
	if (live?.generation?.message !== undefined) {
		parts.push(...renderMessage(live.generation.message as AssistantMessage, true));
	}
	for (const tool of live?.tools ?? []) {
		const head = tool.status === "running" ? green(`${tool.name} running`) : dim(`${tool.name} ${tool.status}`);
		parts.push(new Text(`  ${head}`, 1, 0));
		if (tool.output !== undefined && tool.output !== "") {
			parts.push(new Text(dim(indent(tail(String(tool.output), 6))), 2, 0));
		}
	}
	return parts;
}

function renderEntry(entry: EntryRecord): readonly Text[] {
	switch (entry.kind) {
		case "pi.user":
		case "pi.assistant":
		case "pi.tool-result":
			return (entry.model ?? []).flatMap((message) => renderMessage(message));
		case "pi.reset":
			return [new Text(dim("── context reset ──"), 1, 0)];
		case "pi.compaction":
			return [new Text(dim("── compacted ──"), 1, 0)];
		default:
			return [];
	}
}

/** A transcript message as one or more text blocks. */
function renderMessage(message: Message, streaming = false): readonly Text[] {
	switch (message.role) {
		case "user":
			return [new Text(`${cyan("you")}\n${textOf(message.content)}`, 1, 0)];
		case "toolResult": {
			const mark = message.isError ? yellow(`${message.toolName} ✗`) : dim(`${message.toolName} ✓`);
			return [new Text(`  ${mark}\n${dim(indent(tail(textOf(message.content), 8)))}`, 1, 0)];
		}
		case "assistant": {
			const parts: Text[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					parts.push(new Text(`${green("key")}${streaming ? dim(" …") : ""}\n${block.text}`, 1, 0));
				} else if (block.type === "thinking") {
					parts.push(new Text(dim(indent(tail(block.thinking, 4))), 2, 0));
				} else if (block.type === "toolCall") {
					parts.push(new Text(dim(`  → ${block.name}(${oneLine(block.arguments)})`), 1, 0));
				}
			}
			return parts;
		}
		default:
			return [];
	}
}

function textOf(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function tail(text: string, lines: number): string {
	const all = text.split("\n");
	return all.slice(Math.max(0, all.length - lines)).join("\n").trimEnd();
}

function oneLine(value: unknown): string {
	const text = JSON.stringify(value ?? {});
	return text === undefined ? "" : text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Attach one transcript's SSE stream; `onView` runs for the snapshot and every later revision. */
function watchTranscript(base: string, id: number, onView: (view: ConversationView) => void): { readonly stop: () => void } {
	const abort = new AbortController();
	void (async () => {
		try {
			for await (const view of stream<ConversationView>(`${base}/api/conversations/${id}`, abort.signal)) onView(view);
		} catch (error) {
			if (!abort.signal.aborted) throw error;
		}
	})();
	return { stop: () => abort.abort() };
}

/** Parse an SSE body into typed frames. */
async function* stream<T>(url: string, signal?: AbortSignal): AsyncGenerator<T> {
	const response = await fetch(url, { headers: { accept: "text/event-stream" }, ...(signal === undefined ? {} : { signal }) });
	if (!response.ok || response.body === null) throw new Error(`host returned ${response.status}`);
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true });
		let end = buffer.indexOf("\n\n");
		while (end !== -1) {
			const data = buffer
				.slice(0, end)
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("");
			buffer = buffer.slice(end + 2);
			if (data !== "") yield JSON.parse(data) as T;
			end = buffer.indexOf("\n\n");
		}
	}
}

/** Ask the host to submit a prompt into the standing conversation. */
export async function send(base: string, prompt: string): Promise<void> {
	const response = await fetch(`${base}/api/run`, { method: "POST", body: prompt });
	if (!response.ok) throw new Error(`host returned ${response.status}: ${await response.text()}`);
}
