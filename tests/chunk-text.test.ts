import { describe, expect, it } from "vitest";
import { chunkText } from "../src/telegram/chunk-text.js";
import { formatTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

describe("chunkText", () => {
	it("keeps supported markdown tables intact when they fit within a chunk", () => {
		const text = [
			"Intro text that should stay outside the table chunk.",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| apples | 2 |",
			"",
			"Tail text that should also stay outside the table chunk.",
		].join("\n");

		const chunks = chunkText(text, 60);
		const formattedChunks = chunks.map((chunk) => formatTelegramMarkdown(chunk));
		const tableChunks = formattedChunks.filter((chunk) => chunk.includes("```") && chunk.includes("apples"));

		expect(tableChunks).toHaveLength(1);
		expect(tableChunks[0]).toContain("```\nName");
		expect(tableChunks[0]).toContain("apples");
		expect(tableChunks[0]?.match(/```/g)).toHaveLength(2);
	});

	it("splits large markdown tables into separately valid chunks", () => {
		const text = [
			"Summary before the table.",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| alpha | 1 |",
			"| bravo | 2 |",
			"| charlie | 3 |",
			"| delta | 4 |",
			"| echo | 5 |",
			"",
			"Summary after the table.",
		].join("\n");

		const chunks = chunkText(text, 55);
		const repeatedHeaderChunks = chunks.filter((chunk) => chunk.includes("| Name | Value |"));
		const formattedChunks = chunks.map((chunk) => formatTelegramMarkdown(chunk));
		const formattedTableChunks = formattedChunks.filter((chunk) => chunk.includes("```") && chunk.includes("Value"));

		expect(repeatedHeaderChunks.length).toBeGreaterThan(1);
		expect(formattedTableChunks.length).toBeGreaterThan(1);
		expect(formattedTableChunks.every((chunk) => (chunk.match(/```/g)?.length ?? 0) === 2)).toBe(true);
		expect(formattedTableChunks.some((chunk) => chunk.includes("alpha"))).toBe(true);
		expect(formattedTableChunks.some((chunk) => chunk.includes("echo"))).toBe(true);
	});

	it("splits fenced code blocks into complete fenced chunks", () => {
		const text = [
			"Before",
			"```ts",
			"const alpha = 1;",
			"const bravo = 2;",
			"const charlie = 3;",
			"const delta = 4;",
			"```",
			"After",
		].join("\n");

		const chunks = chunkText(text, 45);
		const codeChunks = chunks.filter((chunk) => chunk.includes("```ts") || chunk.includes("```\nconst"));

		expect(codeChunks.length).toBeGreaterThan(1);
		expect(codeChunks.every((chunk) => (chunk.match(/```/g)?.length ?? 0) === 2)).toBe(true);
		expect(codeChunks.some((chunk) => chunk.includes("const alpha = 1;"))).toBe(true);
		expect(codeChunks.some((chunk) => chunk.includes("const delta = 4;"))).toBe(true);
	});

	it("keeps oversized malformed table-like blocks degraded as text through per-chunk markdown formatting", () => {
		const text = [
			"# Summary",
			"Before **bold** note.",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| alpha | 1 |",
			"| bravo | 2 |",
			"| charlie | 3 |",
			"| broken |",
			"",
			"- After item",
		].join("\n");

		const chunks = chunkText(text, 55);
		const formattedChunks = chunks.map((chunk) => formatTelegramMarkdown(chunk));

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.some((chunk) => chunk.includes("| Name | Value |") && chunk.includes("| --- | --- |"))).toBe(false);
		expect(formattedChunks.some((chunk) => chunk.includes("```"))).toBe(false);
		expect(formattedChunks.some((chunk) => chunk.includes("*Summary*"))).toBe(true);
		expect(formattedChunks.some((chunk) => chunk.includes("Before *bold* note\\."))).toBe(true);
		expect(formattedChunks.some((chunk) => chunk.includes("\\| Name \\| Value \\|"))).toBe(true);
		expect(formattedChunks.some((chunk) => chunk.includes("\\| \\-\\-\\- \\| \\-\\-\\- \\|"))).toBe(true);
		expect(formattedChunks.some((chunk) => chunk.includes("\\| broken \\|"))).toBe(true);
		expect(formattedChunks.some((chunk) => chunk.includes("\\- After item"))).toBe(true);
	});
});
