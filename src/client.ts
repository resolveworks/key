// The client: a dumb terminal chat. It types a prompt, asks the host to start a trajectory, then
// streams it. All state lives in the host; this renders views and submits prompts back.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import {
	type Component,
	Container,
	Editor,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type SelectListTheme,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { Summary } from "./host.ts";
import { provider } from "./prompt.ts";
import { style } from "./theme.ts";
import { transcript } from "./trajectory.ts";

const RECONNECT_MS = 250;
/** Where a client restart picks up: the transcript that was open, if any. */
const cursorFile = join(process.cwd(), ".key", "client.json");

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => style.accent(text),
	selectedText: (text) => style.bold(text),
	description: (text) => style.muted(text),
	scrollInfo: (text) => style.dim(text),
	noMatch: (text) => style.dim(text),
};

/** Attach to the host, chat from the prompt, and open past trajectories from the list. */
export async function open(base: string): Promise<void> {
	const tui = new TuiMainScreen(new ProcessTerminal());
	// The terminal owns the screen and the scrollback. Within a view the document only grows, so
	// rendered lines scroll up into history instead of being redrawn. A selector takes the prompt's
	// place in the dock rather than the document, so opening one never shrinks the transcript.
	const document = new Container();
	const dock = new Container();
	const prompt = new Editor(tui, {
		borderColor: style.borderMuted,
		selectList: selectTheme,
	});
	prompt.setAutocompleteProvider(provider(process.cwd()));
	dock.addChild(prompt);
	const footer = new Text("new trajectory · type to start · /resume for past conversations", 1, 0);
	tui.addChild(document);
	tui.addChild(dock);
	tui.addChild(footer);

	let summaries: readonly Summary[] = [];
	let watching: { stop: () => void } | undefined;
	// The open transcript, for returning from the resume list.
	let current: number | undefined;
	// The task whose conversation is not in the summaries yet; we open it as soon as it appears.
	let pending: number | undefined;
	let starting = false;

	/** Replace the document; streaming appends, a view switch starts a new one. */
	const show = (components: readonly Component[]): void => {
		document.clear();
		for (const component of components) document.addChild(component);
	};

	/** The prompt occupies the dock unless a selector displaced it. */
	const showPrompt = (): void => {
		dock.clear();
		dock.addChild(prompt);
		tui.setFocus(prompt);
	};

	const quit = (): void => {
		watching?.stop();
		tui.stop({ preserveScreen: false });
		process.exit(0);
	};

	/** The resume list: arrows select a conversation, enter opens it. */
	const showList = (): void => {
		prompt.setText("");
		watching?.stop();
		watching = undefined;
		const list = makeList(summaries);
		list.onSelect = (item) => showTranscript(Number(item.value));
		list.onCancel = current === undefined ? showNew : () => showTranscript(current as number);
		dock.clear();
		dock.addChild(list);
		tui.setFocus(list);
		footer.setText("↑/↓ select · enter open · esc back · ctrl+c/d quit");
		tui.requestRender();
	};

	/**
	 * Abandon the open conversation: the next prompt starts a fresh trajectory. A view only — the
	 * command that asks for it records the cursor, so boot can still read what was last open.
	 */
	const showNew = (): void => {
		current = undefined;
		prompt.setText("");
		watching?.stop();
		watching = undefined;
		showPrompt();
		show([new Text(style.dim("new trajectory · type to start"), 0, 0)]);
		footer.setText("new trajectory · type to start · /resume for past conversations");
		tui.requestRender();
	};

	/** Open a conversation; its lines are only ever appended, so history stays in scrollback. */
	const showTranscript = (id: number): void => {
		current = id;
		saveCursor(id);
		watching?.stop();
		showPrompt();
		show([new Text(style.dim("connecting…"), 0, 0)]);
		tui.requestRender();
		watching = watchTranscript(base, id, (view) => {
			show(transcript(view));
			const running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			footer.setText(
				`${running ? style.success("● streaming") : style.dim("○ idle")} · type to start a new context`,
			);
			tui.requestRender();
		});
	};

	/** Open the pending trajectory once the host has created its conversation. */
	const update = (): void => {
		if (pending === undefined) return;
		const created = summaries.find((summary) => summary.owner === `task #${pending}`);
		if (created === undefined) return;
		pending = undefined;
		showTranscript(created.id);
	};

	const start = async (text: string): Promise<void> => {
		const value = text.trim();
		if (value === "" || starting || pending !== undefined) return;
		starting = true;
		try {
			pending = await post(base, "/api/run", value);
			prompt.setText("");
			show([new Text(style.dim("starting trajectory…"), 0, 0)]);
			footer.setText("starting · ctrl+c/d quit");
			tui.requestRender();
			update();
		} finally {
			starting = false;
		}
	};

	prompt.onSubmit = (text: string): void => {
		if (text.trim() === "/resume") {
			showList();
			return;
		}
		if (text.trim() === "/new") {
			saveCursor(undefined);
			showNew();
			return;
		}
		void start(text);
	};

	// pi's exit convention: ctrl+c clears the prompt and quits on a second press; ctrl+d quits on
	// an empty prompt. With text in the prompt ctrl+d falls through to delete-forward.
	let lastCtrlC = 0;
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			const now = Date.now();
			if (now - lastCtrlC < 500) quit();
			else {
				lastCtrlC = now;
				prompt.setText("");
				tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && prompt.getText() === "") {
			quit();
			return { consume: true };
		}
		return undefined;
	});

	// A restart reopens what was open, but only once the host confirms it still exists: a cursor is
	// a hint, never a fact, and a stale one must land on a fresh trajectory rather than a dead view.
	const cursor = loadCursor();

	// The first frame is already a complete view, so it starts on the one view that needs no host.
	showNew();
	tui.start();

	// The first summaries are the verdict on the cursor; every frame after only refreshes the list.
	let restored = false;
	for await (const next of stream<readonly Summary[]>(`${base}/api/conversations`)) {
		summaries = next;
		if (!restored) {
			restored = true;
			if (cursor !== undefined && summaries.some((summary) => summary.id === cursor))
				showTranscript(cursor);
		}
		update();
	}
}

/** The transcript the last client had open, if it is still there. */
function loadCursor(): number | undefined {
	try {
		const { conversation } = JSON.parse(readFileSync(cursorFile, "utf8")) as {
			conversation: number | null;
		};
		return conversation ?? undefined;
	} catch {
		return undefined;
	}
}

function saveCursor(conversation: number | undefined): void {
	mkdirSync(join(process.cwd(), ".key"), { recursive: true });
	writeFileSync(cursorFile, JSON.stringify({ conversation: conversation ?? null }));
}

/** One selectable transcript. */
function makeList(summaries: readonly Summary[]): SelectList {
	return new SelectList(
		summaries.map((summary) => ({
			value: String(summary.id),
			label: `#${summary.id}`,
			description: `${summary.running ? style.success("●") : style.dim("○")} ${summary.owner}${summary.label === "" ? "" : ` · ${summary.label}`}`,
		})),
		20,
		selectTheme,
	);
}

/** Attach one transcript's SSE stream; `onView` runs for the snapshot and every later revision. */
function watchTranscript(
	base: string,
	id: number,
	onView: (view: ConversationView) => void,
): { readonly stop: () => void } {
	const abort = new AbortController();
	void (async () => {
		for await (const view of stream<ConversationView>(
			`${base}/api/conversations/${id}`,
			abort.signal,
		))
			onView(view);
	})();
	return { stop: () => abort.abort() };
}

/** Follow an SSE endpoint as typed frames, reconnecting whenever the host restarts. */
async function* stream<T>(url: string, signal?: AbortSignal): AsyncGenerator<T> {
	for (;;) {
		try {
			const response = await fetch(url, {
				headers: { accept: "text/event-stream" },
				...(signal === undefined ? {} : { signal }),
			});
			if (!response.ok || response.body === null)
				throw new Error(`host returned ${response.status}`);
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
		} catch {
			if (signal?.aborted) return;
		}
		await delay(RECONNECT_MS);
	}
}

/** Ask the host to mint a context from the prompt, and return the task it created. */
async function post(base: string, path: string, prompt: string): Promise<number> {
	for (;;) {
		try {
			const response = await fetch(`${base}${path}`, { method: "POST", body: prompt });
			if (!response.ok)
				throw new Error(`host returned ${response.status}: ${await response.text()}`);
			return ((await response.json()) as { readonly task: number }).task;
		} catch (error) {
			// A restarting host refuses the connection; anything else is a real failure.
			if (!(error instanceof TypeError)) throw error;
			await delay(RECONNECT_MS);
		}
	}
}
