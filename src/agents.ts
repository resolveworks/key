// Project instructions: pi's AGENTS file discovery, rendered as a durable prompt section. Every request
// re-reads the files, so an edit patches the system prompt the same way pi's reload does.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** First match wins: an override shadows the ordinary file in the same directory. */
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

type ProjectFile = { readonly path: string; readonly content: string };

/** From `cwd` up to the filesystem root, outermost first: nearer files read as the more specific ones. */
function projectFiles(cwd: string): readonly ProjectFile[] {
	const files: ProjectFile[] = [];
	for (let dir = cwd; ; ) {
		const path = CANDIDATES.map((name) => join(dir, name)).find(isFile);
		if (path !== undefined) {
			files.unshift({ path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") });
		}
		const parent = dirname(dir);
		if (parent === dir) return files;
		dir = parent;
	}
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

function render(files: readonly ProjectFile[]): string | undefined {
	if (files.length === 0) return undefined;
	return [
		"Project-specific instructions and guidelines:",
		...files.map(
			({ path, content }) =>
				`<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

export const Agents = defineExtension({
	name: "agents",
	sections: [
		section("project_context", (input) =>
			input.agent.cwd === undefined ? undefined : render(projectFiles(input.agent.cwd)),
		),
	],
});
