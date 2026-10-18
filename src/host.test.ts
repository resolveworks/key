import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Agents } from "./agents.ts";
import { Host, type Summary } from "./host.ts";
import { KeySystem } from "./system.ts";

/** A host's SSE stream, read frame by frame with data lines joined the way the client joins them. */
class Frames {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#decoder = new TextDecoder();
	#buffer = "";

	constructor(body: ReadableStream<Uint8Array>) {
		this.#reader = body.getReader();
	}

	/** Resolve with the first frame a predicate accepts, waiting for chunks while it matches none. */
	async until<T>(accept: (frame: T) => boolean, timeoutMs = 2000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const end = this.#buffer.indexOf("\n\n");
			if (end !== -1) {
				const frame = this.#buffer.slice(0, end);
				this.#buffer = this.#buffer.slice(end + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.slice("data: ".length))
					.join("");
				const parsed = JSON.parse(data) as T;
				if (accept(parsed)) return parsed;
				continue;
			}
			if (Date.now() > deadline) throw new Error("no frame matched before the timeout");
			const { value, done } = await this.#reader.read();
			if (done) throw new Error("the stream ended before a frame matched");
			this.#buffer += this.#decoder.decode(value, { stream: true });
		}
	}

	close(): Promise<void> {
		return this.#reader.cancel();
	}
}

describe("host", () => {
	let host: Host;
	let faux: ReturnType<typeof fauxProvider>;
	let base: string;

	beforeEach(async () => {
		// The host configures deepseek/deepseek-flash, so the faux provider serves that pair.
		faux = fauxProvider({ provider: "deepseek", models: [{ id: "deepseek-flash" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		host = new Host({
			models: () => models,
			storage: () => new MemoryStorage(),
			extensions: [CodingTools, KeySystem, Agents],
			port: 0,
		});
		await host.open();
		await host.listen();
		base = host.url;
	});

	afterEach(async () => {
		await host.close();
	});

	test("the root lists the routes", async () => {
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		const body = await response.text();
		expect(body.length).toBeGreaterThan(0);
	});

	test("an unknown path is not found", async () => {
		const response = await fetch(`${base}/nothing/here`);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("not found");
	});

	test("an unknown transcript is not found", async () => {
		const response = await fetch(`${base}/api/conversations/999999`);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("no such conversation");
	});

	test("an empty prompt is rejected", async () => {
		for (const path of ["/api/run", "/api/conversations/1/messages"]) {
			const response = await fetch(`${base}${path}`, { method: "POST", body: "  \n\t" });
			expect(response.status).toBe(400);
			expect(await response.text()).toBe("empty prompt");
		}
	});

	test("the conversation list streams a snapshot and later changes", async () => {
		const response = await fetch(`${base}/api/conversations`);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const frames = new Frames(response.body as ReadableStream<Uint8Array>);
		expect(await frames.until((frame: readonly Summary[]) => frame.length === 0)).toEqual([]);

		faux.setResponses([fauxAssistantMessage("hello")]);
		await fetch(`${base}/api/run`, { method: "POST", body: "say hello" });

		const listed = await frames.until((frame: readonly Summary[]) => frame.length > 0);
		expect(listed.map(({ label }) => label)).toEqual(["say hello"]);
		await frames.close();
	});

	test("a transcript streams its view", async () => {
		const { id, task } = await startRun("say hello");

		const response = await fetch(`${base}/api/conversations/${id}`);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const frames = new Frames(response.body as ReadableStream<Uint8Array>);

		// The first frame is a whole view, and later frames carry each revision the run commits.
		const snapshot = await frames.until((view: ConversationView) => view.conversation.id === id);
		expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
		]);
		const answer = snapshot.entries.at(-1)?.model?.[0];
		expect(answer).toMatchObject({ role: "assistant", content: [{ text: "hello" }] });
		await frames.close();
	});

	/** Start a context from a prompt and find the conversation its task owns. */
	async function startRun(prompt: string): Promise<{ id: number; task: number }> {
		faux.setResponses([fauxAssistantMessage("hello")]);
		const list = new Frames(
			(await fetch(`${base}/api/conversations`)).body as ReadableStream<Uint8Array>,
		);
		const { task } = (await (
			await fetch(`${base}/api/run`, { method: "POST", body: prompt })
		).json()) as { task: number };
		const listed = await list.until((frame: readonly Summary[]) => frame.length > 0);
		expect(listed[0].owner).toBe(`task #${task}`);
		await list.close();
		return { id: listed[0].id, task };
	}
});
