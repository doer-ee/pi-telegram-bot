import { describe, expect, it } from "vitest";
import { formatTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

describe("formatTelegramMarkdown", () => {
	it("escapes Telegram MarkdownV2 specials while preserving simple inline markdown", () => {
		expect(formatTelegramMarkdown("Use **bold** and `code` safely."))
			.toBe("Use *bold* and `code` safely\\.");
	});

	it("keeps complete fenced code blocks formatted safely", () => {
		expect(formatTelegramMarkdown("# Title\n```ts\nconst value = foo_bar();\n```\n- done"))
			.toBe("*Title*\n```\nconst value = foo_bar();\n```\n\\- done");
	});
});
