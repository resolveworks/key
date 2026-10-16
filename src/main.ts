import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, type TaskGraphNode } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem, KeyTask } from "./system.ts";

const context = BACKGROUND_CONTEXT;

const model = process.env.KEY_MODEL ?? "";
const slash = model.indexOf("/");
if (slash <= 0 || slash === model.length - 1) throw new Error('KEY_MODEL must be "provider/modelId"');
const provider = model.slice(0, slash);
const modelId = model.slice(slash + 1);

const workspace = process.cwd();
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

// Terminal answers, printed when a task record settles; the graph drops terminal nodes.
harness.subscribeCommits((publication) => {
	for (const change of publication.changes) {
		if (change.type !== "task" || change.value.kind !== KeyTask.definition.name) continue;
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
	switch (state.status) {
		case "waiting":
			return `  task/${node.id} waiting on ${state.on.join(", ")}`;
		case "completing":
			return `  task/${node.id} completing (${state.outcome})`;
		default:
			return `  task/${node.id} ${state.status} ${state.phase}`;
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
