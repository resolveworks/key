import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { open } from "./client.ts";
import { Host, PORT } from "./host.ts";

const base = process.env.KEY_HOST ?? `http://127.0.0.1:${PORT}`;

const usage = `usage: key <command> [args...]

  serve            own the session and serve the graph
  client           chat with a running host: start trajectories, stream them, browse past ones

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

	const [command] = positionals;
	if (values.help || command === undefined) {
		process.stdout.write(usage);
		return;
	}

	switch (command) {
		case "serve":
			await serve();
			break;
		case "client":
			await open(base);
			break;
		default:
			fail(`unknown command "${command}"`);
	}
}

async function serve(): Promise<void> {
	process.loadEnvFile(join(homedir(), ".key", ".env"));
	const host = new Host();
	await host.open();
	await host.listen();
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void host.close().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(error);
					process.exit(1);
				},
			);
		});
	}
}

function fail(message: string): void {
	process.stderr.write(`key: ${message}\n\n${usage}`);
	process.exitCode = 1;
}
