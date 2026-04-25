import { chunkText } from "./chunk-text.js";
import type { TelegramMessageClient, TelegramTextParseMode } from "./telegram-message-client.js";

export interface TelegramReplyStreamerOptions {
	throttleMs: number;
	chunkSize: number;
	thinkingText?: string;
	abortedText?: string;
	emptyCompletionText?: string;
}

export class TelegramReplyStreamer {
	private readonly thinkingText: string;
	private readonly abortedText: string;
	private readonly emptyCompletionText: string;
	private readonly messageIds: number[] = [];
	private lastChunks: string[] = [];
	private lastRenderMode: TelegramTextParseMode = "plain";
	private pending: Promise<void> = Promise.resolve();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private lastFlushAt = 0;
	private latestText = "";

	constructor(
		private readonly client: TelegramMessageClient,
		private readonly chatId: number,
		private readonly options: TelegramReplyStreamerOptions,
	) {
		this.thinkingText = options.thinkingText ?? "Thinking...";
		this.abortedText = options.abortedText ?? "Run aborted.";
		this.emptyCompletionText = options.emptyCompletionText ?? "Run finished with no assistant text.";
	}

	async start(): Promise<void> {
		await this.enqueue(async () => {
			if (this.messageIds.length > 0) {
				return;
			}
			await this.renderChunks([this.thinkingText], "plain");
		});
	}

	pushText(text: string): void {
		this.latestText = text;
		this.scheduleFlush();
	}

	async finish(status: "completed" | "aborted" | "error", fallbackText?: string): Promise<void> {
		if (fallbackText !== undefined) {
			this.latestText = fallbackText;
		} else if (status === "aborted" && this.latestText.length === 0) {
			this.latestText = fallbackText ?? this.abortedText;
		} else if (status === "completed" && this.latestText.length === 0) {
			this.latestText = fallbackText ?? this.emptyCompletionText;
		} else if (status === "error" && this.latestText.length === 0) {
			this.latestText = this.emptyCompletionText;
		}

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}

		await this.flush(status === "completed" ? "markdown" : "plain");
		await this.pending;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) {
			return;
		}

		const elapsed = Date.now() - this.lastFlushAt;
		const delay = Math.max(0, this.options.throttleMs - elapsed);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, delay);
	}

	private async flush(renderMode: TelegramTextParseMode = "plain"): Promise<void> {
		await this.enqueue(async () => {
			const nextChunks = chunkText(this.latestText || this.thinkingText, this.options.chunkSize);
			if (chunksMatch(this.lastChunks, nextChunks) && this.lastRenderMode === renderMode) {
				return;
			}
			await this.renderChunks(nextChunks, renderMode);
		});
	}

	private async renderChunks(nextChunks: string[], renderMode: TelegramTextParseMode): Promise<void> {
		for (const [index, chunk] of nextChunks.entries()) {
			const messageId = this.messageIds[index];
			if (messageId === undefined) {
				const newMessageId = await this.client.sendText(this.chatId, chunk, { parseMode: renderMode });
				this.messageIds.push(newMessageId);
				continue;
			}

			if (this.lastChunks[index] === chunk && this.lastRenderMode === renderMode) {
				continue;
			}

			try {
				await this.client.editText(this.chatId, messageId, chunk, { parseMode: renderMode });
			} catch (error) {
				if (!isTelegramNotModifiedError(error)) {
					throw error;
				}
			}
		}

		for (let index = this.messageIds.length - 1; index >= nextChunks.length; index -= 1) {
			const messageId = this.messageIds[index];
			if (messageId === undefined) {
				continue;
			}
			await this.client.deleteText(this.chatId, messageId);
			this.messageIds.splice(index, 1);
		}

		this.lastChunks = nextChunks;
		this.lastRenderMode = renderMode;
		this.lastFlushAt = Date.now();
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		this.pending = this.pending.then(task, task);
		return this.pending;
	}
}

function chunksMatch(current: string[], next: string[]): boolean {
	if (current.length !== next.length) {
		return false;
	}

	return current.every((chunk, index) => chunk === next[index]);
}

function isTelegramNotModifiedError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return error.message.toLowerCase().includes("message is not modified");
}
