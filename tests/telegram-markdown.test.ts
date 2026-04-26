import { describe, expect, it } from "vitest";
import { formatTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

describe("formatTelegramMarkdown", () => {
	it("escapes Telegram MarkdownV2 specials while preserving simple inline markdown", () => {
		expect(formatTelegramMarkdown("Use **bold** and `code` safely."))
			.toBe("Use *bold* and `code` safely\\.");
	});

	it("converts supported pipe tables into fenced monospace blocks while preserving surrounding markdown", () => {
		expect(formatTelegramMarkdown([
			"# Report",
			"- Use **bold** summary",
			"1. Review `code`",
			"",
			"| Name | Count |",
			"| --- | ---: |",
			"| apples | 2 |",
			"| bananas | 12 |",
			"",
			"After ~~done~~.",
		].join("\n"))).toBe([
			"*Report*",
			"\\- Use *bold* summary",
			"1\\. Review `code`",
			"",
			"```",
			"Name    | Count",
			"------- | -----",
			"apples  |     2",
			"bananas |    12",
			"```",
			"",
			"After ~done~\\.",
		].join("\n"));
	});

	it("leaves malformed pipe table-like blocks as escaped text", () => {
		const formatted = formatTelegramMarkdown([
			"| Name | Count |",
			"| --- | --- |",
			"| only one cell |",
		].join("\n"));

		expect(formatted).not.toContain("```");
		expect(formatted).toContain("\\| Name \\| Count \\|");
		expect(formatted).toContain("\\| only one cell \\|");
	});

	it("keeps complete fenced code blocks formatted safely", () => {
		expect(formatTelegramMarkdown("# Title\n```ts\nconst value = foo_bar();\n```\n- done"))
			.toBe("*Title*\n```\nconst value = foo_bar();\n```\n\\- done");
	});
});
