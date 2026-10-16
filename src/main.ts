import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, type TaskGraphNode } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;

const workspace = process.cwd();
process.loadEnvFile(join(workspace, ".env"));

const model = process.env.KEY_MODEL ?? "";
const slash = model.indexOf("/");
if (slash <= 0 || slash === model.length - 1) throw new Error('KEY_MODEL must be "provider/modelId"');
const provider = model.slice(0, slash);
const modelId = model.slice(slash + 1);

const dataDirectory = join(workspace, ".key");
mkdirSync(dataDirectory, { recursive: true });

const registry = createRegistry();
registry.install(CodingTools);
registry.install(KeySystem);

const harness = await Harness.open(
	await openNodeSqliteStorage(join(dataDirectory, "session.sqlite")),
	{
		models: builtinModels(),
		registry,
		env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
		onReport: (error) => console.error("key:", error),
	},
	context,
);
const root = await harness.root(context, { agent: { model: { provider, modelId }, cwd: workspace } });

const goal = process.env.KEY_GOAL;
if (goal !== undefined && goal !== "") {
	await harness.commit(async (tx) => {
		(await tx.doc(GoalDoc)).text = goal;
	}, context);
}

// Prompts per context, so the live graph can label nodes instead of dumping IDs.
const prompts = new Map<string, string>();
const emitters = new Map<string, string>();

// Terminal answers, printed when a task record settles; the graph drops terminal nodes.
harness.subscribeCommits((publication) => {
	for (const change of publication.changes) {
		if (change.type !== "task" || change.value.kind !== KeyTask.definition.name) continue;
		const input = change.value.input as KeyTaskInput;
		prompts.set(String(change.value.id), input.prompt);
		if (input.emission !== undefined) emitters.set(String(change.value.id), String(input.emission.emitter));
		const state = change.value.state;
		if (state.status !== "terminal" && state.status !== "completing") continue;
		const result = state.outcome.status === "completed" ? state.outcome.result : `(${state.outcome.status})`;
		console.log(`\n── task/${change.value.id} ${state.outcome.status} ──\n${String(result)}\n`);
	}
});

const rendered = new Map<string, string>();
const watch = await harness.watchTaskGraph(context);
watch.start(async (graph) => {
	const live = new Set<string>();
	for (const [key, node] of Object.entries(graph.tasks)) {
		// Only contexts are ours; the rest is the model's own tool-call plumbing.
		if (node.kind !== KeyTask.definition.name) continue;
		live.add(key);
		const line = renderNode(node);
		if (rendered.get(key) === line) continue;
		rendered.set(key, line);
		console.log(line);
	}
	for (const key of rendered.keys()) if (!live.has(key)) rendered.delete(key);
});

harness.resume();
console.log(`key — model ${provider}/${modelId}, workspace ${workspace}`);

let prompt = process.argv.slice(2).join(" ").trim();
if (prompt === "") prompt = await readPrompt();

if (prompt === "") {
	console.error("usage: node src/main.ts <prompt>");
	process.exitCode = 2;
} else {
	await root.commit((tx) => tx.createTask(KeyTask, { prompt }, { ownership: { kind: "conversation" } }), context);
	await harness.waitForIdle(context);
}

await watch.stop();
await harness.close(context);

function renderNode(node: TaskGraphNode): string {
	const state = node.state;
	const emitter = emitters.get(String(node.id));
	const origin = emitter === undefined ? "" : ` from task/${emitter}`;
	const prompt = prompts.get(String(node.id)) ?? "";
	const label = prompt === "" ? "" : ` — ${prompt.split("\n")[0]}`;
	switch (state.status) {
		case "waiting":
			return `  task/${node.id}${origin} waiting on ${state.on.join(", ")}${label}`;
		case "completing":
			return `  task/${node.id}${origin} completing (${state.outcome})${label}`;
		default:
			return `  task/${node.id}${origin} ${state.status} ${state.phase}${label}`;
	}
}

async function readPrompt(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() ?? "";
	}
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await lines.question("key> ")).trim();
	} finally {
		lines.close();
	}
}
