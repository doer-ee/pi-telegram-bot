import { describe, expect, it } from "vitest";
import { TELEGRAM_BOT_COMMANDS, getTelegramHelpLines } from "../src/telegram/telegram-command-definitions.js";

describe("switch command removal", () => {
	it("omits /switch from the registered Telegram commands", () => {
		expect(TELEGRAM_BOT_COMMANDS.some((command) => command.command === "switch")).toBe(false);
	});

	it("omits /switch from the generated help lines", () => {
		expect(getTelegramHelpLines().some((line) => line.includes("/switch"))).toBe(false);
	});
});
