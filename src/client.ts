// The client: a dumb terminal chat. It types a prompt, asks the host to start a trajectory, then
// streams it. All state lives in the host; this renders views and submits prompts back.

import { setTimeout as delay } from "node:timers/promises";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import {
	Container,
	Input,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	SelectList,
	type SelectListTheme,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { Summary } from "./host.ts";
import { style } from "./theme.ts";
import { transcript } from "./trajectory.ts";

const RECONNECT_MS = 250;

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => style.accent(text),
	selectedText: (text) => style.bold(text),
	description: (text) => style.muted(text),
	scrollInfo: (text) => style.dim(text),
	noMatch: (text) => style.dim(text),
};

/** Attach to the host, chat from the prompt, and open past trajectories from the list. */
export async function open(base: string): Promise<void> {
	const tui = new TuiAltScreen(new ProcessTerminal());
	const body = new Container();
	const scroll = new ScrollView(body, {
		follow: "end",
		primary: true,
		scrollbarTrackStyle: style.scrollbar.track,
		scrollbarThumbStyle: style.scrollbar.thumb,
	});
	const prompt = new Input({
		prompt: style.accent("> "),
	});
	const footer = new Text("", 1, 0);

	let mode: "list" | "transcript" | undefined;
	let summaries: readonly Summary[] = [];
	let watching: { stop: () => void } | undefined;
	// The open transcript, when typing continues it instead of starting a new trajectory.
	let current: number | undefined;
	// The task whose conversation is not in the summaries yet; we open it as soon as it appears.
	let pending: number | undefined;
	let starting = false;

	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, minSize: 1 },
			{
				component: prompt,
				basis: "auto",
				shrink: 1,
				minSize: 1,
				visible: () => mode !== "list",
			},
			{ component: footer, basis: "auto", shrink: 1, minSize: 1 },
		]),
	);

	const quit = (): void => {
		watching?.stop();
		tui.stop({ preserveScreen: false });
		process.exit(0);
	};

	/** The resume list: arrows select a conversation, enter opens it. */
	const showList = (): void => {
		mode = "list";
		current = undefined;
		prompt.setValue("");
		watching?.stop();
		watching = undefined;
		body.clear();
		const list = makeList(summaries);
		list.onSelect = (item) => showTranscript(Number(item.value));
		const back = current === undefined ? showNew : () => showTranscript(current as number);
		list.onCancel = back;
		body.addChild(list);
		tui.setFocus(list);
		footer.setText(style.muted("↑/↓ select · enter open · esc back · ctrl+c quit"));
		tui.requestRender();
	};

	/** Abandon the open conversation: the next prompt starts a fresh trajectory. */
	const showNew = (): void => {
		mode = "transcript";
		current = undefined;
		prompt.setValue("");
		watching?.stop();
		watching = undefined;
		body.clear();
		body.addChild(new Text(style.dim("new trajectory · type to start"), 1, 0));
		tui.setFocus(prompt);
		footer.setText(style.muted("new trajectory · type to start · /resume for past conversations"));
		tui.requestRender();
	};

	const showTranscript = (id: number): void => {
		mode = "transcript";
		current = id;
		watching?.stop();
		body.clear();
		body.addChild(new Text(style.dim("connecting…"), 1, 0));
		tui.setFocus(prompt);
		tui.requestRender();
		watching = watchTranscript(base, id, (view) => {
			body.clear();
			for (const entry of transcript(view)) body.addChild(entry);
			const label = summaries.find((summary) => summary.id === id);
			const running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			const state = running ? style.success("● streaming") : style.dim("○ idle");
			const tail = label?.label ?? `conversation ${id}`;
			footer.setText(`${state}${style.muted(` · ${tail} · type to continue`)}`);
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
		if (mode === "transcript" && current !== undefined) {
			starting = true;
			try {
				await post(base, `/api/conversations/${current}/messages`, value);
				prompt.setValue("");
				tui.requestRender();
			} finally {
				starting = false;
			}
			return;
		}
		starting = true;
		try {
			pending = await post(base, "/api/run", value);
			prompt.setValue("");
			body.clear();
			body.addChild(new Text(style.dim("starting trajectory…"), 1, 0));
			footer.setText(style.muted("starting · ctrl+c quit"));
			tui.requestRender();
			update();
		} finally {
			starting = false;
		}
	};

	prompt.onSubmit = (text) => {
		if (text.trim() === "/resume") {
			showList();
			return;
		}
		if (text.trim() === "/new") {
			showNew();
			return;
		}
		void start(text);
	};

	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			quit();
			return { consume: true };
		}
		return undefined;
	});

	tui.setFocus(prompt);
	tui.start();

	for await (const next of stream<readonly Summary[]>(`${base}/api/conversations`)) {
		summaries = next;
		update();
	}
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
