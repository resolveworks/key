import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AssistantEntry, createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem } from "./system.ts";

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

harness.resume();
console.log(`key — model ${provider}/${modelId}, workspace ${workspace}`);

let prompt = process.argv.slice(2).join(" ").trim();
if (prompt === "") prompt = await readPrompt();

if (prompt === "") {
	console.error("usage: node src/main.ts <prompt>");
	process.exitCode = 2;
} else {
	const goalText = (await harness.snapshot(GoalDoc, context))?.text ?? "";
	const content = goalText === "" ? prompt : `# Goal\n\n${goalText}\n\n---\n\n${prompt}`;

	// Attach before submitting so no early deltas are missed.
	const stream = await watchEvents(harness, root.id, context);
	let streamed = false;
	stream.start(async (events) => {
		for (const event of events) {
			if (event.type !== "message_update") continue;
			for (const change of event.changes) {
				if (change.type !== "text_delta") continue;
				streamed = true;
				process.stdout.write(change.delta);
			}
		}
	});

	const submission = await root.submit({ type: "input", content }, context);
	const settled = await submission.wait(context);
	// Event callbacks run after their commit; let the last ones print.
	await harness.waitForIdle(context);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await stream.stop();

	if (settled.status === "done" && settled.type === "input") {
		if (!streamed) {
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0] as AssistantMessage | undefined;
			const answer = message?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";
			process.stdout.write(answer);
		}
		process.stdout.write("\n");
	} else {
		console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
		process.exitCode = 1;
	}
}

await harness.close(context);

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
