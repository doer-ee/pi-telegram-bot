import { formatTelegramMarkdown } from "./telegram-markdown.js";

export type TelegramTextParseMode = "plain" | "markdown";

export interface TelegramTextOptions {
	parseMode?: TelegramTextParseMode;
	silent?: boolean;
}

export interface TelegramApi {
	sendMessage(
		chatId: number,
		text: string,
		extra?: { parse_mode?: "MarkdownV2"; disable_notification?: boolean },
	): Promise<{ message_id: number }>;
	editMessageText(
		chatId: number,
		messageId: number,
		inlineMessageId: undefined,
		text: string,
		extra?: { parse_mode?: "MarkdownV2" },
	): Promise<unknown>;
	deleteMessage(chatId: number, messageId: number): Promise<unknown>;
	pinChatMessage(chatId: number, messageId: number, extra?: { disable_notification?: boolean }): Promise<unknown>;
	unpinChatMessage(chatId: number, messageId: number): Promise<unknown>;
}

export interface TelegramMessageClient {
	sendText(chatId: number, text: string, options?: TelegramTextOptions): Promise<number>;
	editText(chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void>;
	deleteText(chatId: number, messageId: number): Promise<void>;
	pinText(chatId: number, messageId: number): Promise<void>;
	unpinText(chatId: number, messageId: number): Promise<void>;
}

export function createTelegramMessageClient(telegram: TelegramApi): TelegramMessageClient {
	return {
		async sendText(chatId: number, text: string, options?: TelegramTextOptions): Promise<number> {
			const silentExtra = options?.silent ? { disable_notification: true } : undefined;

			if (options?.parseMode === "markdown") {
				try {
					const message = await telegram.sendMessage(
						chatId,
						formatTelegramMarkdown(text),
						silentExtra
							? { parse_mode: "MarkdownV2", disable_notification: true }
							: { parse_mode: "MarkdownV2" },
					);
					return message.message_id;
				} catch (error) {
					if (!isTelegramFormattingRejectedError(error)) {
						throw error;
					}
				}
			}

			const message = await telegram.sendMessage(chatId, text, silentExtra);
			return message.message_id;
		},
		async editText(chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void> {
			if (options?.parseMode === "markdown") {
				try {
					await telegram.editMessageText(chatId, messageId, undefined, formatTelegramMarkdown(text), {
						parse_mode: "MarkdownV2",
					});
					return;
				} catch (error) {
					if (!isTelegramFormattingRejectedError(error)) {
						throw error;
					}
				}
			}

			await telegram.editMessageText(chatId, messageId, undefined, text);
		},
		async deleteText(chatId: number, messageId: number): Promise<void> {
			await telegram.deleteMessage(chatId, messageId);
		},
		async pinText(chatId: number, messageId: number): Promise<void> {
			await telegram.pinChatMessage(chatId, messageId, {
				disable_notification: true,
			});
		},
		async unpinText(chatId: number, messageId: number): Promise<void> {
			await telegram.unpinChatMessage(chatId, messageId);
		},
	};
}

function isTelegramFormattingRejectedError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();
	if (message.includes("message is not modified")) {
		return false;
	}

	return (
		message.includes("bad request") ||
		message.includes("can't parse entities") ||
		message.includes("parse entities") ||
		message.includes("message is too long") ||
		message.includes("text is too long")
	);
}
