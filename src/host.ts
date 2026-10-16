// The host: one process owns the Session on SQLite and serves the graph and the transcripts over
// HTTP+SSE. Clients attach to a snapshot and then follow frames; reconnecting is native.
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type ConversationId,
	type ConversationView,
	createRegistry,
	type Cursor,
	Harness,
	ROOT_CONVERSATION_ID,
	type TaskGraph,
	type TaskInspection,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** One live trajectory the client can render. */
export type Frame = {
	readonly scheduling: string;
	readonly tasks: readonly Trajectory[];
	readonly submissions: readonly { readonly id: number; readonly status: string; readonly conversationId: number }[];
};

export type Trajectory = {
	readonly id: number;
	readonly kind: string;
	/** Emitted-by task id, when known. */
	readonly from?: number;
	readonly status: string;
	readonly prompt: string;
};

/** One line in the transcript picker: a conversation, its owner, and whether it is running. */
export type Summary = {
	readonly id: number;
	/** `standing` for the human's conversation, otherwise `task #N` or `independent`. */
	readonly owner: string;
	/** The task prompt, or a name for the standing conversation. */
	readonly label: string;
	readonly running: boolean;
};

export type HostOptions = {
	readonly workspace: string;
	readonly dataDirectory: string;
	readonly port: number;
	readonly model: () => { readonly provider: string; readonly modelId: string };
};

export class Host {
	readonly #options: HostOptions;
	#harness!: Harness;
	#labels = new Map<string, { prompt: string; from?: number }>();
	#frame: Frame = { scheduling: "idle", tasks: [], submissions: [] };
	#summaries: readonly Summary[] = [];
	#graph: TaskGraph = { tasks: {} };
	#listeners = new Set<ServerResponse>();
	#listListeners = new Set<ServerResponse>();

	constructor(options: HostOptions) {
		this.#options = options;
	}

	async open(): Promise<void> {
		mkdirSync(this.#options.dataDirectory, { recursive: true });
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(KeySystem);
		this.#harness = await Harness.open(
			await openNodeSqliteStorage(join(this.#options.dataDirectory, "session.sqlite")),
			{
				models: builtinModels(),
				registry,
				env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? this.#options.workspace }),
				onReport: (error) => console.error("key:", error),
			},
			context,
		);

		// Labels are not in the graph, so recover every key.task's input and then follow commits.
		await this.#harness.commit(async (tx) => {
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanTasks({ kind: KeyTask.definition.name }, SCAN_PAGE_SIZE, cursor);
				for (const record of page.items) this.#record(record);
				if (page.next === undefined) break;
				cursor = page.next;
			}
		}, context);

		this.#harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "task") this.#record(change.value);
			}
		});

		await this.#refresh();
		const watch = await this.#harness.watchTaskGraph(context);
		watch.start((graph) => {
			this.#graph = graph;
			return this.#refresh();
		});
	}

	/** Submit a turn into the standing conversation; contexts cascade from it. */
	async submit(prompt: string): Promise<void> {
		const root = await this.#harness.root(context, {
			agent: { model: this.#options.model(), cwd: this.#options.workspace },
		});
		const goal = (await this.#harness.snapshot(GoalDoc, context))?.text ?? "";
		const content = goal === "" ? prompt : `# Goal\n\n${goal}\n\n---\n\n${prompt}`;
		await root.submit({ type: "input", content }, context);
	}

	#record(record: { readonly id: number; readonly input: unknown }): void {
		const input = record.input as KeyTaskInput | undefined;
		if (input?.prompt === undefined) return;
		this.#labels.set(String(record.id), {
			prompt: input.prompt,
			...(input.emission === undefined ? {} : { from: input.emission.emitter }),
		});
	}

	/** Read the graph and inspections once, then push both the frame and the transcript list. */
	async #refresh(): Promise<void> {
		const { scheduling, tasks, submissions } = await this.#harness.inspect(context);
		this.#frame = {
			scheduling,
			tasks: tasks
				.filter((task) => task.record.kind === KeyTask.definition.name)
				.map((task) => this.#trajectory(task)),
			submissions: submissions.map(({ id, status, conversationId }) => ({ id, status, conversationId })),
		};
		this.#summaries = await this.#summarise();
		broadcast(this.#listeners, this.#frame);
		broadcast(this.#listListeners, this.#summaries);
	}

	async #summarise(): Promise<readonly Summary[]> {
		const conversations = await this.#scanConversations();
		// A conversation runs while a task it owns, or the task that owns it, is live.
		const running = new Set<number>();
		for (const node of Object.values(this.#graph.tasks)) {
			if (node.state.status === "pending" || node.state.status === "running") {
				running.add(node.conversationId);
				for (const owned of node.conversations) running.add(owned);
			}
		}
		return conversations
			.map(({ id, owner }) => {
				const label = this.#labels.get(String(owner?.taskId));
				return {
					id,
					owner:
						id === ROOT_CONVERSATION_ID
							? "standing"
							: owner === undefined
								? "independent"
								: `task #${owner.taskId}`,
					label: label?.prompt.split("\n", 1)[0]?.trim() || (id === ROOT_CONVERSATION_ID ? "standing conversation" : ""),
					running: running.has(id),
				};
			})
			.sort((a, b) => b.id - a.id);
	}

	async #scanConversations(): Promise<readonly { id: number; owner?: { taskId: number } }[]> {
		return this.#harness.commit(async (tx) => {
			const found: { id: number; owner?: { taskId: number } }[] = [];
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanConversations({}, SCAN_PAGE_SIZE, cursor);
				for (const record of page.items) {
					found.push({
						id: record.id,
						...(record.owner === undefined ? {} : { owner: { taskId: record.owner.taskId } }),
					});
				}
				if (page.next === undefined) break;
				cursor = page.next;
			}
			return found;
		}, context);
	}

	#trajectory(task: TaskInspection): Trajectory {
		const label = this.#labels.get(String(task.record.id));
		const state = task.state;
		const status =
			state.kind === "waiting"
				? `waiting on ${state.on.map((id) => `#${id}`).join(", ")}`
				: state.kind === "blocked"
					? `blocked (${state.reason})`
					: state.kind;
		return {
			id: task.record.id,
			kind: task.record.kind,
			...(label?.from === undefined ? {} : { from: label.from }),
			status,
			prompt: label?.prompt ?? "",
		};
	}

	async listen(): Promise<void> {
		const server = createServer((req, res) => {
			void this.#handle(req, res).catch((error: unknown) => {
				console.error(error);
				if (!res.headersSent) res.writeHead(500).end(String(error));
			});
		});
		const { port } = this.#options;
		server.listen(port, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		process.stdout.write(`key host on http://127.0.0.1:${port}\n`);
		this.#harness.resume();
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(
				"key host\n\n  GET  /api/graph             snapshot as JSON\n  GET  /api/stream            graph snapshot, then frames (SSE)\n  GET  /api/conversations     transcripts, then changes (SSE)\n  GET  /api/conversations/:id one transcript, then changes (SSE)\n  POST /api/run               body: the prompt\n",
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/graph") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.#frame));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/stream") {
			this.#stream(res, this.#frame, this.#listeners);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/conversations") {
			this.#stream(res, this.#summaries, this.#listListeners);
			return;
		}
		const transcript = /^\/api\/conversations\/(\d+)$/.exec(url.pathname);
		if (req.method === "GET" && transcript !== null) {
			await this.#transcript(Number(transcript[1]), req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/run") {
			const prompt = (await readBody(req)).trim();
			if (prompt === "") {
				res.writeHead(400).end("empty prompt");
				return;
			}
			await this.submit(prompt);
			res.writeHead(202).end("{}");
			return;
		}
		res.writeHead(404).end("not found");
	}

	/** Attach one transcript: the current view, then every later revision through durable's own watch. */
	async #transcript(id: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const conversation = await this.#harness.conversation(id as ConversationId, context);
		if (conversation === undefined) {
			res.writeHead(404).end("no such conversation");
			return;
		}
		res.writeHead(200, sseHeaders());
		const watch = await conversation.watch(context);
		res.write(`data: ${JSON.stringify(watch.value)}\n\n`);
		watch.start(async (view: ConversationView) => {
			res.write(`data: ${JSON.stringify(view)}\n\n`);
		});
		req.on("close", () => void watch.stop());
	}

	#stream(res: ServerResponse, snapshot: unknown, listeners: Set<ServerResponse>): void {
		res.writeHead(200, sseHeaders());
		res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
		listeners.add(res);
		res.on("close", () => listeners.delete(res));
	}

	async close(): Promise<void> {
		for (const listener of [...this.#listeners, ...this.#listListeners]) listener.end();
		await this.#harness.close(context);
	}
}

function sseHeaders(): Record<string, string> {
	return { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };
}

function broadcast(listeners: Set<ServerResponse>, value: unknown): void {
	const payload = `data: ${JSON.stringify(value)}\n\n`;
	for (const listener of listeners) listener.write(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
