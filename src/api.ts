// The API: hono routes over the host. Bodies parse through TypeBox; both streams are SSE.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Type from "typebox";
import { Parse } from "typebox/value";
import type { Host, Summary } from "./host.ts";

/** What `POST /api/run` takes: a trajectory's prompt, and the directory it runs in. */
const RunInput = Type.Object({
  prompt: Type.String(),
  cwd: Type.String(),
});

const index = `key host

  GET  /api/conversations              transcripts, then changes (SSE)
  GET  /api/conversations/:id          one transcript, then changes (SSE)
  POST /api/run                        {prompt, cwd}: start a context in that directory
  POST /api/conversations/:id/messages  message a context from the body
`;

/** The host's whole HTTP surface. */
export function api(host: Host): Hono {
  const app = new Hono();

  app.get("/", (c) => c.text(index));

  app.get("/api/conversations", (c) =>
    streamSSE(c, async (stream) => {
      const send = (summaries: readonly Summary[]) =>
        stream.writeSSE({ data: JSON.stringify(summaries) });
      await send(host.summaries);
      const stop = host.onSummaries((summaries) => void send(summaries));
      stream.onAbort(() => stop());
      while (!stream.aborted) await stream.sleep(1000); // keepalive, and the exit on disconnect
    }),
  );

  app.get("/api/conversations/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const watch = await host.watch(id);
    if (watch === undefined) return c.text("no such conversation", 404);
    return streamSSE(c, async (stream) => {
      const send = async (view: unknown) =>
        stream.writeSSE({ data: JSON.stringify({ view, stats: await host.stats(id) }) });
      await send(watch.value);
      watch.start((view) => send(view));
      stream.onAbort(() => void watch.stop());
      while (!stream.aborted) await stream.sleep(1000);
    });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const prompt = (await c.req.text()).trim();
    if (prompt === "") return c.text("empty prompt", 400);
    await host.continue(Number(c.req.param("id")), prompt);
    return c.body(null, 202);
  });

  app.post("/api/run", async (c) => {
    const { prompt, cwd } = Parse(RunInput, await c.req.json());
    if (prompt.trim() === "" || cwd === "") return c.text("empty prompt or cwd", 400);
    const task = await host.run(cwd, prompt);
    return c.json({ task }, 202);
  });

  // A stack trace is the error message: everything the host throws answers as itself.
  app.onError((error, c) => c.text(String(error), 500));
  app.notFound((c) => c.text("not found", 404));
  return app;
}
