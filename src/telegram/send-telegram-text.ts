import { chunkText } from "./chunk-text.js";
import type { TelegramMessageClient, TelegramTextParseMode } from "./telegram-message-client.js";

export async function sendStandaloneTelegramText(
	client: TelegramMessageClient,
	chatId: number,
	text: string,
	renderMode: TelegramTextParseMode,
	chunkSize: number,
): Promise<void> {
	for (const chunk of chunkText(text, chunkSize)) {
		await client.sendText(chatId, chunk, { parseMode: renderMode });
	}
}
