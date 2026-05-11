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
			{ command: "new", description: "Create and select a new Pi session" },
			{ command: "sessions", description: "List sessions and select one" },
			{ command: "model", description: "Choose the current session model" },
			{ command: "schedule", description: "Start the schedule flow" },
			{ command: "schedules", description: "List scheduled tasks" },
			{ command: "rename", description: "Rename the selected session" },
			{ command: "abort", description: "Abort the active run" },
			{ command: "start", description: "Show bot status and help" },
			{ command: "status", description: "Show bot and session status" },
			{ command: "current", description: "Show the selected session" },
			{ command: "unschedule", description: "Choose a scheduled task to delete" },
			{ command: "runscheduled", description: "Choose a scheduled task to run now" },
			{ command: "help", description: "Show available commands" },
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

		expect(helpText).toContain("/rename - Rename the selected session");
		expect(helpText).toContain("/schedule - Start the schedule flow");
		expect(helpText).toContain("/runscheduled - Choose a scheduled task to run now");
		expect(helpText).toContain("/unschedule - Choose a scheduled task to delete");
		expect(helpText).toContain("Any non-command text message is sent to the selected session.");
		expect(helpText).toContain("Private photos and supported image documents are sent with the image attached to the prompt.");
		expect(helpText).toContain("Plain-text documents (.txt, .md, .json, .csv, .tsv, .log) are staged under the system temp directory and read from disk by Pi.");
		expect(helpText).toContain("Supported PDFs and office documents are staged under the system temp directory and routed through pi-docparser.");
		expect(helpText).toContain("Unsupported documents or parser-unready pi-docparser environments fail explicitly.");
		expect(helpText).toContain(
			"If no session is selected yet, the first freeform message or supported upload creates one automatically.",
		);
	});
});
