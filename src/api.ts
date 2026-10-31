// The API: hono routes over the host. Bodies parse through TypeBox; both streams are SSE.

import type { ConversationView } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";
import Type from "typebox";
import { Parse, ParseError } from "typebox/value";
import type { Host, Summary } from "./host.ts";

/** A prompt any endpoint takes: at least one character that is not whitespace. */
const Prompt = Type.String({ pattern: "\\S" });

/** What `POST /api/run` takes: a trajectory's prompt, and the directory it runs in. */
const RunInput = Type.Object({
  prompt: Prompt,
  cwd: Type.String({ minLength: 1 }),
});

/** What `POST /api/conversations/:id/messages` takes: the prompt that messages a conversation. */
const MessageInput = Type.Object({ prompt: Prompt });

/** What `POST /api/complete` takes: the line as it stands before the cursor, the directory it
 * names paths against, and whether the tab key forced the asking. */
const CompleteInput = Type.Object({
  cwd: Type.String({ minLength: 1 }),
  text: Type.String(),
  force: Type.Optional(Type.Boolean()),
});

/** What `POST /api/models/defaults` takes: which default, and the model it points at. */
const ModelDefaultInput = Type.Object({
  target: Type.Union([Type.Literal("conversation"), Type.Literal("child")]),
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
});

const index = `key host

  GET  /api/conversations              transcripts, then changes (SSE)
  GET  /api/conversations/:id          one transcript, then changes (SSE)
  POST /api/run                        {prompt, cwd} → {conversation}: start a conversation in that directory
  POST /api/complete                   {cwd, text, force}: the host's completion of one prompt line
  POST /api/conversations/:id/messages  {prompt}: message a conversation
  POST /api/conversations/:id/abort     interrupt a conversation: abort its current run
  GET  /api/models                     catalog and the two defaults
  POST /api/models/defaults            {target, provider, modelId}: set a default
`;

/** What one thrown error answers: the error as text — but a parse failure keeps its details on
 * its cause, so those answer as the paths the schema failed on. */
function answer(error: unknown): string {
  if (error instanceof ParseError)
    return error.cause.errors
      .map(({ instancePath, message }) => `${instancePath} ${message}`)
      .join("; ");
  return String(error);
}

/** The host's whole HTTP surface, chained so its type carries every route to the client. */
export function api(host: Host) {
  return (
    new Hono()
      .get("/", (c) => c.text(index))
      .get("/api/conversations", (c) =>
        streamSSE(c, async (stream) => {
          const send = (summaries: readonly Summary[]) =>
            stream.writeSSE({ data: JSON.stringify(summaries) });
          await send(host.summaries);
          const stop = host.onSummaries((summaries) => void send(summaries));
          stream.onAbort(() => stop());
          while (!stream.aborted) await stream.sleep(1000); // keepalive, and the exit on disconnect
        }),
      )
      .get("/api/conversations/:id", async (c) => {
        const id = Number(c.req.param("id"));
        const watch = await host.watch(id);
        if (watch === undefined) return c.text("no such conversation", 404);
        return streamSSE(c, async (stream) => {
          const send = async (view: ConversationView) =>
            stream.writeSSE({ data: JSON.stringify({ view, stats: await host.stats(view) }) });
          await send(watch.value);
          watch.start(async (call) => {
            if (call.kind === "value") await send(call.value);
          });
          stream.onAbort(() => void watch.stop());
          while (!stream.aborted) await stream.sleep(1000);
        });
      })
      .post(
        "/api/conversations/:id/messages",
        validator("json", (body) => Parse(MessageInput, body)),
        async (c) => {
          const { prompt } = c.req.valid("json");
          await host.continue(Number(c.req.param("id")), prompt);
          return c.body(null, 202);
        },
      )
      .post("/api/conversations/:id/abort", async (c) => {
        await host.interrupt(Number(c.req.param("id")));
        return c.body(null, 202);
      })
      .post(
        "/api/run",
        validator("json", (body) => Parse(RunInput, body)),
        async (c) => {
          const { prompt, cwd } = c.req.valid("json");
          const conversation = await host.run(cwd, prompt);
          return c.json({ conversation }, 202);
        },
      )
      .get("/api/models", async (c) => c.json(await host.modelSettings()))
      .post(
        "/api/models/defaults",
        validator("json", (body) => Parse(ModelDefaultInput, body)),
        async (c) => {
          const { target, provider, modelId } = c.req.valid("json");
          await host.setModelDefault(target, { provider, modelId });
          return c.body(null, 202);
        },
      )
      .post(
        "/api/complete",
        validator("json", (body) => Parse(CompleteInput, body)),
        async (c) => {
          const { cwd, text, force } = c.req.valid("json");
          return c.json(await host.complete(cwd, text, force ?? false, c.req.raw.signal));
        },
      )
      // A stack trace is the error message: everything the host throws answers as itself.
      .onError((error, c) => c.text(answer(error), 500))
      .notFound((c) => c.text("not found", 404))
  );
}
