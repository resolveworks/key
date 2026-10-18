// The client: a dumb terminal chat. It types a prompt, asks the host to start a trajectory, then
// streams it. All state lives in the host; the client keeps a mode and renders from it on change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
	Spacer,
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

/** What the screen shows: a fresh trajectory, the resume list, or one open conversation. */
type Mode =
	| { readonly kind: "new" }
	| { readonly kind: "list"; readonly back: "new" | number; selected: number | undefined }
	| { readonly kind: "transcript"; readonly id: number };

/** Attach to the host, chat from the prompt, and open past trajectories from the list. */
export async function open(base: string): Promise<void> {
	const tui = new TuiMainScreen(new ProcessTerminal());
	// The terminal owns the screen and the scrollback. Within a view the document only grows, so
	// rendered lines scroll up into history instead of being redrawn. A selector replaces the
	// document and clears the dock, so the list owns a clean screen.
	const document = new Container();
	const dock = new Container();
	const prompt = new Editor(tui, {
		borderColor: style.borderMuted,
		selectList: selectTheme,
	});
	prompt.setAutocompleteProvider(provider(process.cwd()));
	const footer = new Text("", 1, 0);
	tui.addChild(document);
	tui.addChild(dock);
	tui.addChild(footer);

	// All client state. Every change flows through `render`, which derives the whole screen from it.
	let mode: Mode = { kind: "new" };
	let summaries: readonly Summary[] = [];
	let view: ConversationView | undefined;
	/** The task whose conversation is not in the summaries yet; we open it as soon as it appears. */
	let pending: number | undefined;
	/** A failed action, shown once and replaced by whatever the state says next. */
	let notice: string | undefined;
	let starting = false;

	// Effects: the transcript stream runs exactly while a transcript is open, and the dock holds
	// the prompt exactly when typing is possible.
	let watching: { readonly stop: () => void } | undefined;
	let watchedId: number | undefined;

	/** Replace the document; streaming appends, a view switch starts a new one. */
	const show = (components: readonly Component[]): void => {
		document.clear();
		for (const component of components) document.addChild(component);
	};

	const showPrompt = (): void => {
		dock.clear();
		dock.addChild(prompt);
		tui.setFocus(prompt);
	};

	const hidePrompt = (): void => dock.clear();

	/** The one effect: keep the transcript stream in step with the mode. */
	const syncWatch = (): void => {
		const id = mode.kind === "transcript" ? mode.id : undefined;
		if (id === watchedId) return;
		watching?.stop();
		watching = undefined;
		watchedId = id;
		view = undefined;
		if (id !== undefined)
			watching = watchTranscript(base, id, (frame) => {
				view = frame;
				notice = undefined;
				render();
			});
	};

	/** View = f(state): the whole screen derives from the client state, on every change. */
	const render = (): void => {
		syncWatch();
		if (mode.kind === "list") {
			const page = mode;
			prompt.setText("");
			hidePrompt();
			const list = makeList(summaries);
			const index = summaries.findIndex((summary) => summary.id === page.selected);
			if (index >= 0) list.setSelectedIndex(index);
			list.onSelectionChange = (item) => {
				if (mode.kind === "list") mode.selected = Number(item.value);
			};
			list.onSelect = (item) => open(Number(item.value));
			list.onCancel = () => (page.back === "new" ? enter({ kind: "new" }) : open(page.back));
			show([new Spacer(1), list]);
			tui.setFocus(list);
			footer.setText("↑/↓ select · enter open · esc back · ctrl+c/d quit");
		} else if (mode.kind === "new") {
			showPrompt();
			show([
				pending === undefined
					? new Text(style.dim("new trajectory · type to start"), 0, 0)
					: new Text(style.dim("starting trajectory…"), 0, 0),
			]);
			footer.setText(
				pending === undefined
					? "new trajectory · type to start · /resume for past conversations"
					: "starting · ctrl+c/d quit",
			);
		} else {
			const page = mode;
			showPrompt();
			if (view === undefined) show([new Text(style.dim("connecting…"), 0, 0)]);
			else {
				show(transcript(view));
				const running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
				const closed = summaries.find((summary) => summary.id === page.id)?.closed ?? false;
				footer.setText(
					closed
						? `${style.dim("○ closed")} · /new for a fresh trajectory`
						: `${running ? style.success("● streaming") : style.dim("○ idle")} · type to continue`,
				);
			}
		}
		if (notice !== undefined) footer.setText(notice);
		tui.requestRender();
	};

	/** Enter a mode: records the cursor, then renders. The one way the view ever changes. */
	const enter = (next: Mode): void => {
		if (next.kind === "transcript") saveCursor(next.id);
		mode = next;
		notice = undefined;
		render();
	};

	/** Open a conversation; its lines are only ever appended, so history stays in scrollback. */
	const open = (id: number): void => enter({ kind: "transcript", id });

	const quit = (): void => {
		watching?.stop();
		tui.stop({ preserveScreen: false });
		process.exit(0);
	};

	const start = async (text: string): Promise<void> => {
		const value = text.trim();
		if (value === "" || starting || pending !== undefined) return;
		starting = true;
		try {
			if (mode.kind === "transcript") {
				await post(base, `/api/conversations/${mode.id}/messages`, value);
			} else {
				// The client's directory is the trajectory's: launch it from the project root.
				pending = await post(
					base,
					"/api/run",
					JSON.stringify({ prompt: value, cwd: process.cwd() }),
				);
			}
			prompt.setText("");
			notice = undefined;
			render();
		} catch (error) {
			notice = String(error);
			render();
		} finally {
			starting = false;
		}
	};

	prompt.onSubmit = (text: string): void => {
		if (text.trim() === "/resume") {
			enter({
				kind: "list",
				back: mode.kind === "transcript" ? mode.id : "new",
				selected: undefined,
			});
			return;
		}
		if (text.trim() === "/new") {
			saveCursor(undefined);
			enter({ kind: "new" });
			return;
		}
		void start(text);
	};

	// pi's exit convention: ctrl+c clears the prompt and quits on a second press; ctrl+d quits on an
	// empty prompt. With text in the prompt ctrl+d falls through to delete-forward.
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

	// The first frame is already a complete view, so it starts on the one view that needs no host.
	render();
	tui.start();

	// The first summaries are the verdict on the cursor: a cursor is a hint, never a fact, and a
	// stale one must land on a fresh trajectory rather than a dead view. Every frame after only
	// refreshes the screen — the list's status dots included.
	const cursor = loadCursor();
	let restored = false;
	for await (const next of stream<readonly Summary[]>(`${base}/api/conversations`)) {
		summaries = next;
		if (!restored) {
			restored = true;
			if (cursor !== undefined && summaries.some((summary) => summary.id === cursor))
				enter({ kind: "transcript", id: cursor });
		}
		// Open the pending trajectory once the host has created its conversation.
		if (pending !== undefined) {
			const created = summaries.find((summary) => summary.owner === `task #${pending}`);
			if (created !== undefined) {
				pending = undefined;
				open(created.id);
			}
		}
		render();
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
			description: `${summary.running ? style.success("●") : summary.closed ? "×" : style.dim("○")} ${summary.cwd === "" ? "" : `${style.dim(basename(summary.cwd))} · `}${summary.owner}${summary.label === "" ? "" : ` · ${summary.label}`}`,
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
async function post(base: string, path: string, body: string): Promise<number> {
	for (;;) {
		try {
			const response = await fetch(`${base}${path}`, { method: "POST", body });
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
