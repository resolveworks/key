// hono routes over the host: TypeBox-validated bodies, SSE for the two streams.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView, EntryId } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";
import Type, { type Static } from "typebox";
import { Parse, ParseError, Parser } from "typebox/value";
import { TARGETS, type Target } from "./defaults.ts";
import type { Host, Summary } from "./host.ts";
import { THINKING_LEVELS } from "./thinking.ts";

/** A prompt: at least one character that is not whitespace. */
const Prompt = Type.String({ pattern: "\\S" });

const RunInput = Type.Object({
  prompt: Prompt,
  cwd: Type.String({ minLength: 1 }),
});

const MessageInput = Type.Object({ prompt: Prompt });

const ForkInput = Type.Object({ at: Type.Optional(Type.Number()) });

const CwdInput = Type.Object({
  path: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
});

const CompleteInput = Type.Object({
  cwd: Type.String({ minLength: 1 }),
  text: Type.String(),
  force: Type.Optional(Type.Boolean()),
});

const DefaultTarget = Type.Unsafe<Target>({ type: "string", enum: [...TARGETS] });

const ModelDefaultInput = Type.Object({
  target: DefaultTarget,
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
});

const ThinkingInput = Type.Object({
  target: DefaultTarget,
  level: Type.Unsafe<ModelThinkingLevel>({ type: "string", enum: [...THINKING_LEVELS] }),
});

const LoginInput = Type.Object({
  provider: Type.String({ minLength: 1 }),
  type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
});

const LoginAnswerInput = Type.Object({
  id: Type.Number(),
  value: Type.String(),
});

const EntriesQuery = Type.Object({
  minEntryId: Type.Optional(Type.Number()),
  maxEntryId: Type.Optional(Type.Number()),
  order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])),
  limit: Type.Number(),
});

const index = `key host

  GET  /api/conversations              transcripts, then changes (SSE)
  GET  /api/conversations/:id          one transcript window, then changes (SSE)
  GET  /api/conversations/:id/entries  page entries behind or between the windows
  POST /api/run                        {prompt, cwd} → {conversation}: start a conversation in that directory
  POST /api/cwd                        {path, cwd?} → {cwd}: resolve a real directory on the host
  POST /api/complete                   {cwd, text, force}: the host's completion of one prompt line
  POST /api/conversations/:id/messages  {prompt}: message a conversation
  POST /api/conversations/:id/abort     interrupt a conversation: abort its current run
  POST /api/conversations/:id/fork      {at?}: fork a conversation after that entry, or empty without one
  GET  /api/models                     the configured models and the two defaults
  POST /api/models/defaults            {target, provider, modelId}: set a default
  GET  /api/thinking                   the levels conversations and children run at
  POST /api/thinking                   {target, level}: set one
  GET  /api/providers                  providers and their auth methods
  POST /api/login                      {provider, type}: run a provider login
  GET  /api/login                      the login's prompts and notices (SSE)
  POST /api/login/respond              {id, value}: answer the waiting prompt
  POST /api/login/abort                cancel the login
`;

/** A parse failure answers as the paths the schema failed on; everything else, as itself. */
function answer(error: unknown): string {
  if (error instanceof ParseError)
    return error.cause.errors
      .map(({ instancePath, message }) => `${instancePath} ${message}`)
      .join("; ");
  return String(error);
}

/** Chained so its type carries every route to the client. */
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
      .get(
        "/api/conversations/:id/entries",
        validator("query", (query) => Parser(EntriesQuery, query) as Static<typeof EntriesQuery>),
        async (c) => {
          const { limit, minEntryId, maxEntryId, order } = c.req.valid("query");
          return c.json(
            await host.entries(
              Number(c.req.param("id")),
              {
                ...(minEntryId === undefined ? {} : { minEntryId: minEntryId as EntryId }),
                ...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryId }),
                ...(order === undefined ? {} : { order }),
              },
              limit,
            ),
          );
        },
      )
      .get("/api/conversations/:id", async (c) => {
        const id = Number(c.req.param("id"));
        const watch = await host.watch(id);
        if (watch === undefined) return c.text("no such conversation", 404);
        return streamSSE(c, async (stream) => {
          stream.onAbort(() => void watch.stop());
          // The stats answer what only the host knows, and change only when the place or model
          // does: send them then, never once per transcript frame. Context size changes each frame.
          let statsFor: string | undefined;
          const send = async (view: ConversationView) => {
            const agent = view.docs["pi.agent"] as AgentState | undefined;
            const key = JSON.stringify([agent?.cwd, agent?.model]);
            const stats = key === statsFor ? undefined : await host.stats(view);
            statsFor = key;
            const contextTokens = await host.contextTokens(id);
            await stream.writeSSE({ data: JSON.stringify({ view, stats, contextTokens }) });
          };
          await send(watch.value);
          // The looker may leave before the first frame lands: the abort already stopped the watch.
          if (stream.aborted) return;
          watch.start(async (call) => {
            if (call.kind === "value") await send(call.value);
          });
          while (!stream.aborted) await stream.sleep(1000); // keepalive, and the exit on disconnect
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
        "/api/conversations/:id/fork",
        validator("json", (body) => Parse(ForkInput, body)),
        async (c) => {
          const { at } = c.req.valid("json");
          const conversation = await host.fork(
            Number(c.req.param("id")),
            at as EntryId | undefined,
          );
          return c.json({ conversation }, 202);
        },
      )
      .post(
        "/api/run",
        validator("json", (body) => Parse(RunInput, body)),
        async (c) => {
          const { prompt, cwd } = c.req.valid("json");
          const conversation = await host.run(cwd, prompt);
          return c.json({ conversation }, 202);
        },
      )
      .post(
        "/api/cwd",
        validator("json", (body) => Parse(CwdInput, body)),
        (c) => {
          const { path, cwd } = c.req.valid("json");
          return c.json({ cwd: host.resolveCwd(path, cwd) });
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
      .get("/api/thinking", async (c) => c.json({ defaults: await host.thinkingDefaults() }))
      .post(
        "/api/thinking",
        validator("json", (body) => Parse(ThinkingInput, body)),
        async (c) => {
          const { target, level } = c.req.valid("json");
          await host.setThinkingDefault(target, level);
          return c.body(null, 202);
        },
      )
      .get("/api/providers", async (c) => c.json(await host.providers()))
      .post(
        "/api/login",
        validator("json", (body) => Parse(LoginInput, body)),
        (c) => {
          const { provider, type } = c.req.valid("json");
          host.startLogin(provider, type);
          return c.body(null, 202);
        },
      )
      .get("/api/login", (c) => {
        const login = host.login;
        if (login === undefined) return c.text("no login in progress", 404);
        return streamSSE(c, async (stream) => {
          await new Promise<void>((resolve) => {
            let sent = 0;
            let settled = false;
            let stop = (): void => {};
            let chain = Promise.resolve();
            const finish = (): void => {
              if (settled) return;
              settled = true;
              stop();
              resolve();
            };
            const flush = (): void => {
              chain = chain
                .then(async () => {
                  while (sent < login.events.length) {
                    const event = login.events[sent++];
                    if (!stream.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
                  }
                  if (login.finished) finish();
                })
                .catch(() => finish());
            };
            stop = login.follow(flush);
            flush();
            stream.onAbort(() => {
              stop();
              resolve();
            });
          });
        });
      })
      .post(
        "/api/login/respond",
        validator("json", (body) => Parse(LoginAnswerInput, body)),
        (c) => {
          const login = host.login;
          if (login === undefined) throw new Error("no login in progress");
          const { id, value } = c.req.valid("json");
          login.answer(id, value);
          return c.body(null, 202);
        },
      )
      .post("/api/login/abort", (c) => {
        const login = host.login;
        if (login === undefined) throw new Error("no login in progress");
        login.abort();
        return c.body(null, 202);
      })
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
