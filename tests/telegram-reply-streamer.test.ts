import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramReplyStreamer } from "../src/telegram/telegram-reply-streamer.js";
import type { TelegramMessageClient, TelegramTextOptions } from "../src/telegram/telegram-message-client.js";

describe("TelegramReplyStreamer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("removes trailing chunks when a later streamed update is shorter", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 5,
		});

		await streamer.start();
		streamer.pushText("1234567890");
		await vi.runAllTimersAsync();
		expect(client.getVisibleTexts()).toEqual(["12345", "67890"]);

		streamer.pushText("12345");
		await vi.runAllTimersAsync();

		expect(client.getVisibleTexts()).toEqual(["12345"]);
		expect(client.deletedMessageIds).toHaveLength(1);
	});

	it("renders the completed text exactly even when it shrinks from multiple chunks", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 5,
		});

		await streamer.start();
		streamer.pushText("abcdefghij");
		await vi.runAllTimersAsync();
		await streamer.finish("completed", "abcde");

		expect(client.getVisibleTexts()).toEqual(["abcde"]);
		expect(client.deletedMessageIds).toHaveLength(1);
	});

	it("renders the aborted text exactly and cleans up stale trailing chunks", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 32,
		});

		await streamer.start();
		streamer.pushText("long running assistant reply that spans more than a single telegram chunk");
		await vi.runAllTimersAsync();
		await streamer.finish("aborted", "Stopped.");

		expect(client.getVisibleTexts()).toEqual(["Stopped."]);
		expect(client.deletedMessageIds.length).toBeGreaterThanOrEqual(1);
	});

	it("renders the error text exactly and cleans up stale trailing chunks", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 7,
		});

		await streamer.start();
		streamer.pushText("another long assistant reply");
		await vi.runAllTimersAsync();
		await streamer.finish("error", "Request failed: boom");

		expect(client.getVisibleTexts()).toEqual(["Request", "failed:", "boom"]);
		expect(client.deletedMessageIds.length).toBeGreaterThanOrEqual(1);
	});

	it("keeps streamed updates plain and only applies markdown formatting on completed replies", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 64,
		});

		await streamer.start();
		streamer.pushText("Use **bold** output");
		await vi.runAllTimersAsync();

		expect(client.editCalls.at(-1)?.options?.parseMode ?? "plain").toBe("plain");

		await streamer.finish("completed");

		expect(client.editCalls.at(-1)?.options?.parseMode).toBe("markdown");
	});
});

class MockTelegramMessageClient implements TelegramMessageClient {
	private nextMessageId = 1;
	private readonly messages = new Map<number, { text: string; deleted: boolean }>();
	readonly deletedMessageIds: number[] = [];
	readonly sendCalls: Array<{ text: string; options: TelegramTextOptions | undefined }> = [];
	readonly editCalls: Array<{ messageId: number; text: string; options: TelegramTextOptions | undefined }> = [];

	async sendText(_chatId: number, text: string, options?: TelegramTextOptions): Promise<number> {
		const messageId = this.nextMessageId;
		this.nextMessageId += 1;
		this.messages.set(messageId, { text, deleted: false });
		this.sendCalls.push({ text, options });
		return messageId;
	}

	async editText(_chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void> {
		const message = this.messages.get(messageId);
		if (!message || message.deleted) {
			throw new Error(`Cannot edit missing message ${messageId}`);
		}
		this.editCalls.push({ messageId, text, options });
		message.text = text;
	}

	async deleteText(_chatId: number, messageId: number): Promise<void> {
		const message = this.messages.get(messageId);
		if (!message || message.deleted) {
			return;
		}
		message.deleted = true;
		this.deletedMessageIds.push(messageId);
	}

	async pinText(_chatId: number, _messageId: number): Promise<void> {
		return;
	}

	async unpinText(_chatId: number, _messageId: number): Promise<void> {
		return;
	}

	getVisibleTexts(): string[] {
		return Array.from(this.messages.entries())
			.filter(([, message]) => !message.deleted)
			.sort(([leftId], [rightId]) => leftId - rightId)
			.map(([, message]) => message.text);
	}
}
