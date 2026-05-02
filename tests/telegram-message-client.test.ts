import { describe, expect, it } from "vitest";
import { formatTelegramMarkdown } from "../src/telegram/telegram-markdown.js";
import { createTelegramMessageClient, type TelegramApi } from "../src/telegram/telegram-message-client.js";

describe("createTelegramMessageClient", () => {
	it("omits disable_notification when silent mode is not requested", async () => {
		const telegram = new MockTelegramApi();
		const client = createTelegramMessageClient(telegram);

		const messageId = await client.sendText(42, "Hello there");

		expect(messageId).toBe(1);
		expect(telegram.sendCalls).toEqual([
			{
				chatId: 42,
				text: "Hello there",
				extra: undefined,
			},
		]);
	});

	it("passes silent mode through markdown send fallback attempts", async () => {
		const telegram = new MockTelegramApi();
		telegram.failNextMarkdownSend = true;
		const client = createTelegramMessageClient(telegram);

		const messageId = await client.sendText(42, "Use **bold** output", {
			parseMode: "markdown",
			silent: true,
		});

		expect(messageId).toBe(1);
		expect(telegram.sendCalls).toEqual([
			{
				chatId: 42,
				text: formatTelegramMarkdown("Use **bold** output"),
				extra: { parse_mode: "MarkdownV2", disable_notification: true },
			},
			{
				chatId: 42,
				text: "Use **bold** output",
				extra: { disable_notification: true },
			},
		]);
	});

	it("falls back to plain text when Telegram rejects a markdown edit", async () => {
		const telegram = new MockTelegramApi();
		const client = createTelegramMessageClient(telegram);
		await client.sendText(42, "Thinking...");
		telegram.failNextMarkdownEdit = true;

		await client.editText(42, 1, "Use **bold** output", {
			parseMode: "markdown",
		});

		expect(telegram.editCalls).toEqual([
			{
				chatId: 42,
				messageId: 1,
				inlineMessageId: undefined,
				text: formatTelegramMarkdown("Use **bold** output"),
				extra: { parse_mode: "MarkdownV2" },
			},
			{
				chatId: 42,
				messageId: 1,
				inlineMessageId: undefined,
				text: "Use **bold** output",
				extra: undefined,
			},
		]);
	});
});

class MockTelegramApi implements TelegramApi {
	private nextMessageId = 1;
	readonly sendCalls: Array<{
		chatId: number;
		text: string;
		extra: { parse_mode?: "MarkdownV2"; disable_notification?: boolean } | undefined;
	}> = [];
	readonly editCalls: Array<{
		chatId: number;
		messageId: number;
		inlineMessageId: undefined;
		text: string;
		extra: { parse_mode?: "MarkdownV2" } | undefined;
	}> = [];
	failNextMarkdownSend = false;
	failNextMarkdownEdit = false;

	async sendMessage(
		chatId: number,
		text: string,
		extra?: { parse_mode?: "MarkdownV2"; disable_notification?: boolean },
	): Promise<{ message_id: number }> {
		this.sendCalls.push({ chatId, text, extra });
		if (extra?.parse_mode === "MarkdownV2" && this.failNextMarkdownSend) {
			this.failNextMarkdownSend = false;
			throw new Error("400: Bad Request: can't parse entities");
		}

		const messageId = this.nextMessageId;
		this.nextMessageId += 1;
		return { message_id: messageId };
	}

	async editMessageText(
		chatId: number,
		messageId: number,
		inlineMessageId: undefined,
		text: string,
		extra?: { parse_mode?: "MarkdownV2" },
	): Promise<unknown> {
		this.editCalls.push({ chatId, messageId, inlineMessageId, text, extra });
		if (extra?.parse_mode === "MarkdownV2" && this.failNextMarkdownEdit) {
			this.failNextMarkdownEdit = false;
			throw new Error("400: Bad Request: can't parse entities");
		}

		return undefined;
	}

	async deleteMessage(_chatId: number, _messageId: number): Promise<unknown> {
		return undefined;
	}

	async pinChatMessage(
		_chatId: number,
		_messageId: number,
		_extra?: { disable_notification?: boolean },
	): Promise<unknown> {
		return undefined;
	}

	async unpinChatMessage(_chatId: number, _messageId: number): Promise<unknown> {
		return undefined;
	}
}
