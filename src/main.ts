import { join } from "node:path";
import { parseArgs } from "node:util";
import { follow, send } from "./client.ts";
import { Host } from "./host.ts";

const workspace = process.cwd();
const dataDirectory = join(workspace, ".key");
const base = `http://127.0.0.1:${process.env.KEY_PORT ?? 7317}`;

try {
	process.loadEnvFile(join(workspace, ".env"));
} catch {
	// Missing is fine until a command asks for a model.
}

const usage = `usage: key <command> [args...]

  serve            own the session and serve the graph
  watch            attach to a running host and draw live trajectories
  run <prompt...>  submit a prompt to a running host

  -h, --help       this
`;

await main();

async function main(): Promise<void> {
	let values: { help: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			allowPositionals: true,
			options: { help: { type: "boolean", short: "h", default: false } },
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
		case "serve":
			await serve();
			break;
		case "watch":
			await follow(base);
			break;
		case "run":
			if (prompt === "") return fail("run needs a prompt");
			await send(base, prompt);
			break;
		default:
			fail(`unknown command "${command}"`);
	}
}

async function serve(): Promise<void> {
	const port = Number(process.env.KEY_PORT ?? 7317);
	const model = readModel;
	const host = new Host({ workspace, dataDirectory, port, model });
	await host.open();
	await host.listen();
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => void host.close().finally(() => process.exit(0)));
	}
}

function fail(message: string): void {
	process.stderr.write(`key: ${message}\n\n${usage}`);
	process.exitCode = 1;
}

function readModel(): { provider: string; modelId: string } {
	const model = process.env.KEY_MODEL ?? "";
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) throw new Error('KEY_MODEL must be "provider/modelId"');
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
