import { chunkText } from "./chunk-text.js";
import { sendStandaloneTelegramText } from "./send-telegram-text.js";
import type { TelegramMessageClient, TelegramTextParseMode } from "./telegram-message-client.js";

export interface TelegramReplyStreamerOptions {
	throttleMs: number;
	chunkSize: number;
	thinkingText?: string;
	completedText?: string;
	abortedText?: string;
	errorText?: string;
	emptyCompletionText?: string;
	maxProgressEntries?: number;
}

export class TelegramReplyStreamer {
	private readonly thinkingText: string;
	private readonly completedText: string;
	private readonly abortedText: string;
	private readonly errorText: string;
	private readonly emptyCompletionText: string;
	private readonly maxProgressEntries: number;
	private readonly progressMessageIds: number[] = [];
	private readonly assistantMessageIds: number[] = [];
	private lastProgressChunks: string[] = [];
	private lastAssistantChunks: string[] = [];
	private pending: Promise<void> = Promise.resolve();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private lastFlushAt = 0;
	private progressEntries: string[] = [];
	private completionStatus: "in_progress" | "completed" | "aborted" | "error" = "in_progress";
	private latestAssistantText = "";

	constructor(
		private readonly client: TelegramMessageClient,
		private readonly chatId: number,
		private readonly options: TelegramReplyStreamerOptions,
	) {
		this.thinkingText = options.thinkingText ?? "Thinking...";
		this.completedText = options.completedText ?? "Completed.";
		this.abortedText = options.abortedText ?? "Run aborted.";
		this.errorText = options.errorText ?? "Request failed.";
		this.emptyCompletionText = options.emptyCompletionText ?? "Run finished with no assistant text.";
		this.maxProgressEntries = Math.max(1, options.maxProgressEntries ?? 12);
	}

	async start(): Promise<void> {
		await this.enqueue(async () => {
			if (this.progressMessageIds.length > 0) {
				return;
			}
			await this.renderProgressChunks([this.renderProgressMessage()], "plain");
		});
	}

	pushText(text: string): void {
		if (this.latestAssistantText === text) {
			return;
		}

		this.latestAssistantText = text;
		this.scheduleFlush();
	}

	pushProgress(summary: string): void {
		const normalizedSummary = summary.trim();
		if (normalizedSummary.length === 0) {
			return;
		}

		if (this.progressEntries.at(-1) === normalizedSummary) {
			return;
		}

		this.progressEntries.push(normalizedSummary);
		if (this.progressEntries.length > this.maxProgressEntries) {
			this.progressEntries.splice(0, this.progressEntries.length - this.maxProgressEntries);
		}
		this.scheduleFlush();
	}

	async finish(status: "completed" | "aborted" | "error", fallbackText?: string): Promise<void> {
		this.completionStatus = status;

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}

		await this.flush();
		await this.pending;

		const finalText = this.resolveFinalText(status, fallbackText);
		if (!this.hasRenderedAssistantText(finalText)) {
			await this.sendStandaloneText(finalText, status === "completed" ? "markdown" : "plain");
		}
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

	private async flush(): Promise<void> {
		await this.enqueue(async () => {
			const nextProgressChunks = chunkText(this.renderProgressMessage(), this.options.chunkSize);
			if (!chunksMatch(this.lastProgressChunks, nextProgressChunks)) {
				await this.renderProgressChunks(nextProgressChunks, "plain");
			}

			const nextAssistantChunks = this.latestAssistantText.length > 0
				? chunkText(this.latestAssistantText, this.options.chunkSize)
				: [];
			if (!chunksMatch(this.lastAssistantChunks, nextAssistantChunks)) {
				await this.renderAssistantChunks(nextAssistantChunks, "markdown");
			}

			this.lastFlushAt = Date.now();
		});
	}

	private renderProgressMessage(): string {
		const header = this.getProgressHeader();
		if (this.progressEntries.length === 0) {
			return header;
		}

		return [header, ...this.progressEntries.map((entry) => `• ${entry}`)].join("\n");
	}

	private getProgressHeader(): string {
		switch (this.completionStatus) {
			case "completed":
				return this.completedText;
			case "aborted":
				return this.abortedText;
			case "error":
				return this.errorText;
			default:
				return this.thinkingText;
		}
	}

	private resolveFinalText(status: "completed" | "aborted" | "error", fallbackText?: string): string {
		if (fallbackText !== undefined) {
			return fallbackText;
		}

		if (this.latestAssistantText.length > 0) {
			return this.latestAssistantText;
		}

		switch (status) {
			case "completed":
				return this.emptyCompletionText;
			case "aborted":
				return this.abortedText;
			case "error":
				return this.errorText;
		}
	}

	private hasRenderedAssistantText(text: string): boolean {
		if (this.assistantMessageIds.length === 0 || text.length === 0) {
			return false;
		}

		return chunksMatch(this.lastAssistantChunks, chunkText(text, this.options.chunkSize));
	}

	private async renderProgressChunks(nextChunks: string[], renderMode: TelegramTextParseMode): Promise<void> {
		for (const [index, chunk] of nextChunks.entries()) {
			const messageId = this.progressMessageIds[index];
			if (messageId === undefined) {
				const newMessageId = await this.client.sendText(this.chatId, chunk, {
					parseMode: renderMode,
					silent: true,
				});
				this.progressMessageIds.push(newMessageId);
				continue;
			}

			if (this.lastProgressChunks[index] === chunk) {
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

		for (let index = this.progressMessageIds.length - 1; index >= nextChunks.length; index -= 1) {
			const messageId = this.progressMessageIds[index];
			if (messageId === undefined) {
				continue;
			}
			await this.client.deleteText(this.chatId, messageId);
			this.progressMessageIds.splice(index, 1);
		}

		this.lastProgressChunks = nextChunks;
	}

	private async renderAssistantChunks(nextChunks: string[], renderMode: TelegramTextParseMode): Promise<void> {
		for (const [index, chunk] of nextChunks.entries()) {
			const messageId = this.assistantMessageIds[index];
			if (messageId === undefined) {
				const newMessageId = await this.client.sendText(this.chatId, chunk, {
					parseMode: renderMode,
				});
				this.assistantMessageIds.push(newMessageId);
				continue;
			}

			if (this.lastAssistantChunks[index] === chunk) {
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

		for (let index = this.assistantMessageIds.length - 1; index >= nextChunks.length; index -= 1) {
			const messageId = this.assistantMessageIds[index];
			if (messageId === undefined) {
				continue;
			}
			await this.client.deleteText(this.chatId, messageId);
			this.assistantMessageIds.splice(index, 1);
		}

		this.lastAssistantChunks = nextChunks;
	}

	private async sendStandaloneText(text: string, renderMode: TelegramTextParseMode): Promise<void> {
		await sendStandaloneTelegramText(this.client, this.chatId, text, renderMode, this.options.chunkSize);
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
