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
	type Cursor,
	createRegistry,
	Harness,
	ROOT_CONVERSATION_ID,
	type TaskGraph,
	type TaskInspection,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** One box, one host: these are constants, not configuration. */
export const PORT = 7317;
const workspace = process.cwd();
const dataDirectory = join(workspace, ".key");
const MODEL = { provider: "deepseek", modelId: "deepseek-flash" };

/** One live trajectory the client can render. */
export type Frame = {
	readonly scheduling: string;
	readonly tasks: readonly Trajectory[];
	readonly submissions: readonly {
		readonly id: number;
		readonly status: string;
		readonly conversationId: number;
	}[];
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
	/** The owning `task #N`, or `independent`. */
	readonly owner: string;
	/** The owning task's prompt. */
	readonly label: string;
	readonly running: boolean;
};

export class Host {
	#harness!: Harness;
	#prompts = new Map<number, string>();
	#frame: Frame = { scheduling: "idle", tasks: [], submissions: [] };
	#summaries: readonly Summary[] = [];
	#graph: TaskGraph = { tasks: {} };
	#listeners = new Set<ServerResponse>();
	#listListeners = new Set<ServerResponse>();

	async open(): Promise<void> {
		mkdirSync(dataDirectory, { recursive: true });
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(KeySystem);
		this.#harness = await Harness.open(
			await openNodeSqliteStorage(join(dataDirectory, "session.sqlite")),
			{
				models: builtinModels(),
				registry,
				env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
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

	/**
	 * The human emits: one fresh context for the prompt, in one commit. The root conversation is
	 * reserved — it owns top-level tasks and carries the agent every context copies, and no turn is
	 * ever submitted to it.
	 */
	async run(prompt: string): Promise<void> {
		await this.#harness.root(context, { agent: { model: MODEL, cwd: workspace } });
		await this.#harness.commit(
			(tx) =>
				tx.createTask(
					KeyTask,
					{ prompt },
					{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
				),
			context,
		);
	}

	#record(record: { readonly id: number; readonly input: unknown }): void {
		const input = record.input as KeyTaskInput | undefined;
		if (input?.prompt === undefined) return;
		this.#prompts.set(record.id, input.prompt);
	}

	/** Read the graph and inspections once, then push both the frame and the transcript list. */
	async #refresh(): Promise<void> {
		const { scheduling, tasks, submissions } = await this.#harness.inspect(context);
		this.#frame = {
			scheduling,
			tasks: tasks
				.filter((task) => task.record.kind === KeyTask.definition.name)
				.map((task) => this.#trajectory(task)),
			submissions: submissions.map(({ id, status, conversationId }) => ({
				id,
				status,
				conversationId,
			})),
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
			.filter(({ id }) => id !== ROOT_CONVERSATION_ID)
			.map(({ id, owner }) => {
				const prompt = owner === undefined ? undefined : this.#prompts.get(owner.taskId);
				return {
					id,
					owner: owner === undefined ? "independent" : `task #${owner.taskId}`,
					label: prompt?.split("\n", 1)[0]?.trim() ?? "",
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
		const input = task.record.input as unknown as KeyTaskInput | undefined;
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
			...(input?.emission === undefined ? {} : { from: input.emission.emitter }),
			status,
			prompt: input?.prompt ?? "",
		};
	}

	async listen(): Promise<void> {
		const server = createServer((req, res) => {
			void this.#handle(req, res).catch((error: unknown) => {
				console.error(error);
				if (!res.headersSent) res.writeHead(500).end(String(error));
			});
		});
		server.listen(PORT, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		process.stdout.write(`key host on http://127.0.0.1:${PORT}\n`);
		this.#harness.resume();
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/") {
			res
				.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
				.end(
					"key host\n\n  GET  /api/graph             snapshot as JSON\n  GET  /api/stream            graph snapshot, then frames (SSE)\n  GET  /api/conversations     transcripts, then changes (SSE)\n  GET  /api/conversations/:id one transcript, then changes (SSE)\n  POST /api/run               start a context from the body\n",
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
			await this.run(prompt);
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
	return {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	};
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
