// The host: one process owns the Session on SQLite and serves the graph and the transcripts over
// HTTP+SSE. Clients attach to a snapshot and then follow frames; reconnecting is native.
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Agents } from "./agents.ts";
import { KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** One box, one host: these are constants, not configuration. */
export const PORT = 7317;
const workspace = process.cwd();
const dataDirectory = join(workspace, ".key");
const MODEL = { provider: "deepseek", modelId: "deepseek-flash" };

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
	#continues = new Map<number, number>();
	#summaries: readonly Summary[] = [];
	#graph: TaskGraph = { tasks: {} };
	#server!: Server;
	#listListeners = new Set<ServerResponse>();

	async open(): Promise<void> {
		mkdirSync(dataDirectory, { recursive: true });
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(KeySystem);
		registry.install(Agents);
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

		await this.#publish();
		const watch = await this.#harness.watchTaskGraph(context);
		watch.start((graph) => {
			this.#graph = graph;
			return this.#publish();
		});
	}

	/**
	 * The human emits: one fresh context for the prompt, in one commit. The root conversation is
	 * reserved — it owns top-level tasks and carries the agent every context copies, and no turn is
	 * ever submitted to it.
	 */
	async run(prompt: string): Promise<number> {
		await this.#harness.root(context, { agent: { model: MODEL, cwd: workspace } });
		return this.#harness.commit(
			(tx) =>
				tx.createTask(
					KeyTask,
					{ prompt },
					{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
				),
			context,
		);
	}

	/** The human continues: a fresh context in an existing conversation, in one commit. */
	async continue(conversationId: number, prompt: string): Promise<number> {
		const conversation = await this.#harness.conversation(
			conversationId as ConversationId,
			context,
		);
		if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
		return this.#harness.commit(
			(tx) =>
				tx.createTask(
					KeyTask,
					{ prompt, conversationId: conversation.id },
					{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
				),
			context,
		);
	}

	#record(record: { readonly id: number; readonly kind: string; readonly input: unknown }): void {
		if (record.kind !== KeyTask.definition.name) return;
		const input = record.input as KeyTaskInput;
		this.#prompts.set(record.id, input.prompt);
		if (input.conversationId !== undefined) this.#continues.set(record.id, input.conversationId);
	}

	/** Recompute the transcript list and push it to every attached client. */
	async #publish(): Promise<void> {
		this.#summaries = await this.#summarise();
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
				const continued = this.#continues.get(node.id);
				if (continued !== undefined) running.add(continued);
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

	async listen(): Promise<void> {
		this.#server = createServer((req, res) => {
			void this.#handle(req, res).catch((error: unknown) => {
				console.error(error);
				if (!res.headersSent) res.writeHead(500).end(String(error));
			});
		});
		this.#server.listen(PORT, "127.0.0.1");
		await new Promise((resolve) => this.#server.once("listening", resolve));
		process.stdout.write(`key host on http://127.0.0.1:${PORT}\n`);
		this.#harness.resume();
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url as string, "http://localhost");
		if (req.method === "GET" && url.pathname === "/") {
			res
				.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
				.end(
					"key host\n\n  GET  /api/conversations            transcripts, then changes (SSE)\n  GET  /api/conversations/:id        one transcript, then changes (SSE)\n  POST /api/run                      start a context from the body\n  POST /api/conversations/:id/messages  continue a conversation from the body\n",
				);
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
		const message = /^\/api\/conversations\/(\d+)\/messages$/.exec(url.pathname);
		if (req.method === "POST" && message !== null) {
			const prompt = (await readBody(req)).trim();
			if (prompt === "") {
				res.writeHead(400).end("empty prompt");
				return;
			}
			const task = await this.continue(Number(message[1]), prompt);
			res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ task }));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/run") {
			const prompt = (await readBody(req)).trim();
			if (prompt === "") {
				res.writeHead(400).end("empty prompt");
				return;
			}
			const task = await this.run(prompt);
			res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ task }));
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
		for (const listener of this.#listListeners) listener.end();
		this.#server.close();
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
