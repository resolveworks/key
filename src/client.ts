// The client: a dumb terminal. It reads the host's graph stream and draws the live trajectories,
// and submits prompts back. All state lives in the host; this only renders frames.
import type { Frame, Trajectory } from "./host.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;

/** Attach, draw a snapshot, then redraw on every frame until interrupted. */
export async function follow(base: string): Promise<void> {
	const response = await fetch(`${base}/api/stream`, { headers: { accept: "text/event-stream" } });
	if (!response.ok || response.body === null) throw new Error(`host returned ${response.status}`);
	process.stdout.write("\x1b[?25l"); // hide cursor
	const restore = () => process.stdout.write("\x1b[?25h\n");
	process.once("SIGINT", () => {
		restore();
		process.exit(0);
	});

	let first = true;
	for await (const frame of frames(response.body)) {
		if (!first) process.stdout.write("\x1b[H\x1b[2J");
		first = false;
		draw(frame);
	}
	restore();
}

/** Ask the host to submit a prompt into the standing conversation. */
export async function send(base: string, prompt: string): Promise<void> {
	const response = await fetch(`${base}/api/run`, { method: "POST", body: prompt });
	if (!response.ok) throw new Error(`host returned ${response.status}: ${await response.text()}`);
}

function draw(frame: Frame): void {
	const lines = [bold(`key — ${frame.tasks.length} live trajector${frame.tasks.length === 1 ? "y" : "ies"}`), ""];
	if (frame.tasks.length === 0) lines.push(dim("  nothing running"));
	for (const task of frame.tasks) lines.push(...render(task));
	if (frame.submissions.length > 0) {
		lines.push("", dim(`${frame.submissions.length} queued submission(s)`));
		for (const submission of frame.submissions) {
			lines.push(dim(`  #${submission.id} ${submission.status} → conversation/${submission.conversationId}`));
		}
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function render(task: Trajectory): readonly string[] {
	const origin = task.from === undefined ? "" : dim(` ← #${task.from}`);
	const status = colour(task.status, task.status);
	const prompt = task.prompt.split("\n", 1)[0]?.trim() ?? "";
	return [`  ${bold(`#${task.id}`)}${origin} ${status}`, prompt === "" ? "" : `     ${prompt}`].filter(
		(line) => line !== "",
	);
}

function colour(status: string, text: string): string {
	if (status.startsWith("waiting")) return yellow(text);
	if (status.startsWith("blocked")) return dim(text);
	if (status.startsWith("running")) return green(text);
	return cyan(text);
}

/** Parse an SSE body into frames. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let end = buffer.indexOf("\n\n");
		while (end !== -1) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const data = event
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("");
			if (data !== "") yield JSON.parse(data) as Frame;
			end = buffer.indexOf("\n\n");
		}
	}
}
