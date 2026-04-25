import { describe, expect, it, vi } from "vitest";
import {
	getTelegramHelpLines,
	registerTelegramBotCommands,
	TELEGRAM_BOT_COMMANDS,
} from "../src/telegram/telegram-command-definitions.js";
import { formatHelpText } from "../src/telegram/telegram-formatters.js";

describe("TELEGRAM_BOT_COMMANDS", () => {
	it("matches the supported Telegram command surface", () => {
		expect(TELEGRAM_BOT_COMMANDS).toEqual([
			{ command: "start", description: "Show bot status and help" },
			{ command: "help", description: "Show available commands" },
			{ command: "status", description: "Show bot and session status" },
			{ command: "new", description: "Create and select a new Pi session" },
			{ command: "sessions", description: "List sessions and switch" },
			{ command: "switch", description: "Switch by session id or prefix" },
			{ command: "current", description: "Show the selected session" },
			{ command: "abort", description: "Abort the active run" },
		]);
	});
});

describe("registerTelegramBotCommands", () => {
	it("registers the native Telegram command menu definitions", async () => {
		const setMyCommands = vi.fn(async () => true);

		await registerTelegramBotCommands({ setMyCommands });

		expect(setMyCommands).toHaveBeenCalledOnce();
		expect(setMyCommands).toHaveBeenCalledWith(TELEGRAM_BOT_COMMANDS);
	});
});

describe("formatHelpText", () => {
	it("includes the registered command descriptions", () => {
		const helpText = formatHelpText();

		for (const helpLine of getTelegramHelpLines()) {
			expect(helpText).toContain(helpLine);
		}

		expect(helpText).toContain("Any non-command text message is sent to the selected session.");
	});
});
