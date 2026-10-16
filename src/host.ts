// The host: one process owns the Session on SQLite and serves the graph over HTTP+SSE.
// Clients attach to a snapshot and then follow frames; reconnecting is native.
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, type TaskInspection } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;

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
	#listeners = new Set<ServerResponse>();

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

		// Labels are not in the graph, so seed the recovered ones and follow commits.
		for (const task of (await this.#harness.inspect(context)).tasks) this.#record(task.record);

		this.#harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "task") this.#record(change.value);
			}
		});

		await this.#refresh();
		const watch = await this.#harness.watchTaskGraph(context);
		watch.start(() => void this.#refresh());
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

	/** Read the graph and inspections once, then push the frame to every attached client. */
	async #refresh(): Promise<void> {
		const { scheduling, tasks, submissions } = await this.#harness.inspect(context);
		this.#frame = {
			scheduling,
			tasks: tasks
				.filter((task) => task.record.kind === KeyTask.definition.name)
				.map((task) => this.#trajectory(task)),
			submissions: submissions.map(({ id, status, conversationId }) => ({ id, status, conversationId })),
		};
		const payload = `data: ${JSON.stringify(this.#frame)}\n\n`;
		for (const listener of this.#listeners) listener.write(payload);
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
				"key host\n\n  GET  /api/graph   snapshot as JSON\n  GET  /api/stream  snapshot, then frames (SSE)\n  POST /api/run     body: the prompt\n",
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/graph") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.#frame));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/stream") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`data: ${JSON.stringify(this.#frame)}\n\n`);
			this.#listeners.add(res);
			req.on("close", () => this.#listeners.delete(res));
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

	async close(): Promise<void> {
		for (const listener of this.#listeners) listener.end();
		await this.#harness.close(context);
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
