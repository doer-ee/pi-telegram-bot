import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramReplyStreamer } from "../src/telegram/telegram-reply-streamer.js";
import type { TelegramMessageClient, TelegramTextOptions } from "../src/telegram/telegram-message-client.js";

describe("TelegramReplyStreamer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("streams assistant text live, keeps progress visible, and does not resend the completed answer", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 128,
		});

		await streamer.start();
		streamer.pushProgress("Reading src/session/session-coordinator.ts");
		streamer.pushText("Partial answer");
		await vi.runAllTimersAsync();

		expect(client.getVisibleTexts()).toEqual([
			"Thinking...\n• Reading src/session/session-coordinator.ts",
			"Partial answer",
		]);

		streamer.pushProgress("Running command: npm test");
		streamer.pushText("Final answer");
		await vi.runAllTimersAsync();

		expect(client.getVisibleTexts()).toEqual([
			"Thinking...\n• Reading src/session/session-coordinator.ts\n• Running command: npm test",
			"Final answer",
		]);

		await streamer.finish("completed");

		expect(client.getVisibleTexts()).toEqual([
			"Completed.\n• Reading src/session/session-coordinator.ts\n• Running command: npm test",
			"Final answer",
		]);
		expect(client.editCalls).toEqual([
			{
				messageId: 1,
				text: "Thinking...\n• Reading src/session/session-coordinator.ts",
				options: { parseMode: "plain" },
			},
			{
				messageId: 1,
				text: "Thinking...\n• Reading src/session/session-coordinator.ts\n• Running command: npm test",
				options: { parseMode: "plain" },
			},
			{
				messageId: 2,
				text: "Final answer",
				options: { parseMode: "markdown" },
			},
			{
				messageId: 1,
				text: "Completed.\n• Reading src/session/session-coordinator.ts\n• Running command: npm test",
				options: { parseMode: "plain" },
			},
		]);
		expect(client.sendCalls).toHaveLength(2);
		expect(client.sendCalls[0]).toEqual({
			text: "Thinking...",
			options: { parseMode: "plain", silent: true },
		});
		expect(client.sendCalls[1]).toEqual({ text: "Partial answer", options: { parseMode: "markdown" } });
	});

	it("renders progress updates in plain text and the assistant stream in markdown", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 128,
		});

		await streamer.start();
		streamer.pushProgress("Using skill: listing-agent-research");
		streamer.pushText("Use **bold** output");
		await vi.runAllTimersAsync();
		await streamer.finish("completed");

		expect(client.sendCalls.at(-1)).toEqual({
			text: "Use **bold** output",
			options: { parseMode: "markdown" },
		});
		expect(client.editCalls.filter((call) => call.messageId === 1)).toEqual([
			{
				messageId: 1,
				text: "Thinking...\n• Using skill: listing-agent-research",
				options: { parseMode: "plain" },
			},
			{
				messageId: 1,
				text: "Completed.\n• Using skill: listing-agent-research",
				options: { parseMode: "plain" },
			},
		]);
		expect(client.editCalls.at(-1)?.text).toBe("Completed.\n• Using skill: listing-agent-research");
	});

	it("adds assistant chunks safely as the reply grows past the chunk size", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 12,
		});

		await streamer.start();
		streamer.pushText("hello world");
		await vi.runAllTimersAsync();

		expect(client.getVisibleTexts()).toEqual(["Thinking...", "hello world"]);

		streamer.pushText("hello world again");
		await vi.runAllTimersAsync();
		await streamer.finish("completed");

		expect(client.getVisibleTexts()).toEqual(["Completed.", "hello world", "again"]);
		expect(client.sendCalls).toEqual([
			{
				text: "Thinking...",
				options: { parseMode: "plain", silent: true },
			},
			{
				text: "hello world",
				options: { parseMode: "markdown" },
			},
			{
				text: "again",
				options: { parseMode: "markdown" },
			},
		]);
	});

	it("deduplicates identical progress updates and keeps streamed assistant text separate from an error fallback", async () => {
		vi.useFakeTimers();
		const client = new MockTelegramMessageClient();
		const streamer = new TelegramReplyStreamer(client, 1, {
			throttleMs: 0,
			chunkSize: 128,
		});

		await streamer.start();
		streamer.pushProgress("Reading .../src/session/session-coordinator.ts");
		streamer.pushProgress("Reading .../src/session/session-coordinator.ts");
		streamer.pushText("Partial answer");
		await vi.runAllTimersAsync();
		await streamer.finish("error", "Request failed: boom");

		expect(client.getVisibleTexts()).toEqual([
			"Request failed.\n• Reading .../src/session/session-coordinator.ts",
			"Partial answer",
			"Request failed: boom",
		]);
		expect(client.editCalls).toHaveLength(2);
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
