import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	Harness,
	type TaskGraphNode,
	type TaskInspection,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GoalDoc, KeySystem, KeyTask, type KeyTaskInput } from "./system.ts";

const context = BACKGROUND_CONTEXT;
const workspace = process.cwd();
const dataDirectory = join(workspace, ".key");
const kind = KeyTask.definition.name;

// The .env is optional: only commands that reach a model need KEY_MODEL.
try {
	process.loadEnvFile(join(workspace, ".env"));
} catch {
	// Missing is fine until a command asks for a model.
}

const usage = `usage: key <command> [args...]

  run <prompt...>  submit a prompt, then watch the emitted contexts
  watch            resume and watch live contexts without submitting
  ls [--all]       list live jobs (--all includes the model's tool plumbing)

  -h, --help       this
  --               end flags; the rest is a literal prompt
`;

await main();

async function main(): Promise<void> {
	let values: { all: boolean; help: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			allowPositionals: true,
			options: {
				all: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		}));
	} catch (error) {
		return fail(`bad arguments: ${(error as Error).message}`);
	}

	const [command, ...rest] = positionals;
	if (values.help || command === undefined) {
		process.stdout.write(usage);
		return;
	}

	const prompt = rest.join(" ").trim();
	switch (command) {
		case "run":
			if (prompt === "") return fail("run needs a prompt");
			await live(prompt);
			break;
		case "watch":
			await live();
			break;
		case "ls":
			await list(values.all);
			break;
		default:
			fail(`unknown command "${command}"`);
	}
}

function fail(message: string): void {
	process.stderr.write(`key: ${message}\n\n${usage}`);
	process.exitCode = 1;
}

/** Live jobs in the session, including the waiting ones. Read-only: it never schedules or runs task code. */
async function list(all: boolean): Promise<void> {
	const harness = await openHarness();
	try {
		const { scheduling, tasks, submissions } = await harness.inspect(context);
		const prompts = new Map<string, string>();
		const emitters = new Map<string, string>();
		for (const task of tasks) recordLabel(task.record, prompts, emitters);
		const jobs = tasks.filter((task) => all || task.record.kind === kind);
		process.stdout.write(`scheduling ${scheduling}, ${jobs.length} live job(s)\n`);
		for (const job of jobs) process.stdout.write(`${renderTask(job, prompts, emitters)}\n`);
		if (submissions.length > 0) {
			process.stdout.write(`${submissions.length} unsettled submission(s)\n`);
			for (const submission of submissions) {
				process.stdout.write(
					`  submission/${submission.id} ${submission.status} conversation ${submission.conversationId}\n`,
				);
			}
		}
	} finally {
		await harness.close(context);
	}
}

/** Submit (or, with no prompt, only observe) in the standing conversation while printing emitted contexts as they live. */
async function live(prompt?: string): Promise<void> {
	const { provider, modelId } = readModel();
	const harness = await openHarness();
	try {
		const root = await harness.root(context, { agent: { model: { provider, modelId }, cwd: workspace } });
		const goal = process.env.KEY_GOAL;
		if (goal !== undefined && goal !== "") {
			await harness.commit(async (tx) => {
				(await tx.doc(GoalDoc)).text = goal;
			}, context);
		}

		// Labels are not in the graph, so keep them beside it: seed the recovered ones, then follow commits.
		const prompts = new Map<string, string>();
		const emitters = new Map<string, string>();
		for (const task of (await harness.inspect(context)).tasks) recordLabel(task.record, prompts, emitters);

		const unsubscribe = harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type !== "task" || change.value.kind !== kind) continue;
				recordLabel(change.value, prompts, emitters);
				const state = change.value.state;
				if (state.status !== "terminal" && state.status !== "completing") continue;
				const result = state.outcome.status === "completed" ? state.outcome.result : `(${state.outcome.status})`;
				process.stdout.write(`\n── task/${change.value.id} ${state.outcome.status} ──\n${String(result)}\n`);
			}
		});

		const rendered = new Map<string, string>();
		const watch = await harness.watchTaskGraph(context);
		watch.start(async (graph) => {
			const live = new Set<string>();
			for (const [key, node] of Object.entries(graph.tasks)) {
				// Only contexts are ours; the rest is the model's own tool-call plumbing.
				if (node.kind !== kind) continue;
				live.add(key);
				const line = renderNode(node, prompts, emitters);
				if (rendered.get(key) === line) continue;
				rendered.set(key, line);
				process.stdout.write(`${line}\n`);
			}
			for (const key of rendered.keys()) if (!live.has(key)) rendered.delete(key);
		});

		harness.resume();
		process.stdout.write(`key — model ${provider}/${modelId}, workspace ${workspace}\n`);

		if (prompt !== undefined) await ask(harness, root, prompt);
		await harness.waitForIdle(context);

		// Event callbacks run after their commit; let the last ones print.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await watch.stop();
		unsubscribe();
	} finally {
		await harness.close(context);
	}
}

/** One turn: stream the root's answer, then leave emitted contexts to the graph and commit watchers. */
async function ask(harness: Harness, root: Conversation, prompt: string): Promise<void> {
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
		process.stdout.write(`\nunanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}\n`);
	}
}

async function openHarness(): Promise<Harness> {
	mkdirSync(dataDirectory, { recursive: true });
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(KeySystem);
	return Harness.open(
		await openNodeSqliteStorage(join(dataDirectory, "session.sqlite")),
		{
			models: builtinModels(),
			registry,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
			onReport: (error) => console.error("key:", error),
		},
		context,
	);
}

function readModel(): { provider: string; modelId: string } {
	const model = process.env.KEY_MODEL ?? "";
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) throw new Error('KEY_MODEL must be "provider/modelId"');
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function recordLabel(
	record: { readonly id: number; readonly input: unknown },
	prompts: Map<string, string>,
	emitters: Map<string, string>,
): void {
	const input = record.input as KeyTaskInput;
	prompts.set(String(record.id), input.prompt);
	if (input.emission !== undefined) emitters.set(String(record.id), String(input.emission.emitter));
}

/** One live job line: origin, status, and the first line of its prompt so an agent is not just an id. */
function renderNode(node: TaskGraphNode, prompts: Map<string, string>, emitters: Map<string, string>): string {
	const origin = originOf(node.id, emitters);
	const label = labelOf(node.id, prompts);
	const state = node.state;
	const status =
		state.status === "waiting"
			? `waiting on ${state.on.map((id) => `task/${id}`).join(", ")}`
			: state.status === "completing"
				? `completing (${state.outcome})`
				: `${state.status} ${state.phase}`;
	return `  task/${node.id}${origin} ${status}${label}`;
}

/** One inspection line, used by `ls`; adds the wait edges and blocked reason the graph omits. */
function renderTask(inspection: TaskInspection, prompts: Map<string, string>, emitters: Map<string, string>): string {
	const record = inspection.record;
	const state = inspection.state;
	const status =
		state.kind === "waiting"
			? `waiting on ${state.on.map((id) => `task/${id}`).join(", ")}`
			: state.kind === "ready"
				? state.migrates
					? "pending (migrates)"
					: "pending"
				: state.kind === "blocked"
					? `blocked (${state.reason})`
					: state.kind;
	const phase =
		record.state.status === "pending" || record.state.status === "running" || record.state.status === "waiting"
			? (record.state.checkpoint as { readonly phase?: string } | undefined)?.phase
			: undefined;
	const phaseText = phase === undefined ? "" : ` ${phase}`;
	return `  task/${record.id}${originOf(record.id, emitters)} [${status}${phaseText}] ${record.kind}${labelOf(record.id, prompts)}`;
}

function originOf(id: number | string, emitters: Map<string, string>): string {
	const emitter = emitters.get(String(id));
	return emitter === undefined ? "" : ` from task/${emitter}`;
}

function labelOf(id: number | string, prompts: Map<string, string>): string {
	const prompt = prompts.get(String(id));
	return prompt === undefined || prompt === "" ? "" : ` — ${prompt.split("\n", 1)[0]?.trim() ?? ""}`;
}
