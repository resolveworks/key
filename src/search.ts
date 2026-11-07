// Web search: Brave's index as one tool, behind BRAVE_API_KEY in the host's environment.

import { StringEnum } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";

type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly description?: string;
  readonly extra_snippets?: readonly string[];
};

const asMarkdown = (results: readonly SearchResult[]): string =>
  results
    .map((result, index) => {
      const lines = [`${index + 1}. **[${result.title}](${result.url})**`];
      if (result.description !== undefined) lines.push(`   ${result.description}`);
      for (const snippet of result.extra_snippets ?? []) lines.push(`   > ${snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");

export const Search = defineExtension({
  name: "search",
  tools: [
    defineTool({
      name: "web_search",
      description: "Search the web and return the results as markdown.",
      parameters: obj({
        query: str({ description: "Search query" }),
        freshness: opt(
          StringEnum(["pd", "pw", "pm", "py"] as const, {
            description:
              "Filter by recency: pd (last 24h), pw (last 7 days), pm (last 31 days), py (last year)",
          }),
        ),
      }),
      // A read-only fetch: a rerun after a crash only searches again.
      replay: "safe",
      execute: async ({ query, freshness }, _call, context) => {
        const key = process.env.BRAVE_API_KEY;
        if (key === undefined) throw new Error("BRAVE_API_KEY is not set");
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", query);
        url.searchParams.set("count", "10");
        url.searchParams.set("extra_snippets", "true");
        if (freshness !== undefined) url.searchParams.set("freshness", freshness);
        const response = await fetch(url, {
          headers: { "X-Subscription-Token": key, Accept: "application/json" },
          signal: context.abortSignal,
        });
        if (!response.ok) {
          const body = (await response.text().catch(() => "")).trim();
          throw new Error(
            `Brave search failed (${response.status}): ${body || response.statusText}`,
          );
        }
        const results = ((await response.json()) as { web?: { results?: SearchResult[] } }).web
          ?.results;
        if (results === undefined || results.length === 0)
          return { output: [{ type: "text", text: `No results found for "${query}".` }] };
        return { output: [{ type: "text", text: asMarkdown(results) }] };
      },
    }),
  ],
});
