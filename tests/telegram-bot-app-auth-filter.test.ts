import { describe, expect, it } from "vitest";
import type { Update } from "telegraf/types";
import { shouldRejectUnauthorizedPrivateUpdate } from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const UNAUTHORIZED_USER_ID = 202;
const BOT_USER_ID = 303;

describe("shouldRejectUnauthorizedPrivateUpdate", () => {
	it("rejects unauthorized private text messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateTextMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
					text: "hello from another user",
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("allows authorized private text messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateTextMessageUpdate({
					fromId: AUTHORIZED_USER_ID,
					text: "/status",
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(false);
	});

	it("rejects unauthorized private photo messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivatePhotoMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("rejects unauthorized private audio messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateAudioMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("rejects unauthorized private document messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateDocumentMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("rejects unauthorized private voice messages", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateVoiceMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("rejects unauthorized private callback queries", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivateCallbackQueryUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(true);
	});

	it("ignores private pinned-message service updates", () => {
		expect(
			shouldRejectUnauthorizedPrivateUpdate(
				createPrivatePinnedMessageUpdate({
					fromId: UNAUTHORIZED_USER_ID,
				}),
				AUTHORIZED_USER_ID,
			),
		).toBe(false);
	});
});

function createPrivateTextMessageUpdate(options: { fromId: number; text: string }): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			text: options.text,
		},
	};
}

function createPrivateCallbackQueryUpdate(options: { fromId: number }): Update {
	return {
		update_id: 2,
		callback_query: {
			id: "callback-1",
			chat_instance: "private-chat",
			from: createUser(options.fromId),
			data: "sessions:select:session-1",
			message: {
				message_id: 11,
				date: 1,
				chat: createPrivateChat(options.fromId),
				from: createUser(BOT_USER_ID, true),
				text: "Select a session",
			},
		},
	};
}

function createPrivatePhotoMessageUpdate(options: { fromId: number }): Update {
	return {
		update_id: 4,
		message: {
			message_id: 14,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			photo: [
				{ file_id: "photo-1", file_unique_id: "photo-1-unique", width: 64, height: 64 },
			],
		},
	};
}

function createPrivateAudioMessageUpdate(options: { fromId: number }): Update {
	return {
		update_id: 5,
		message: {
			message_id: 15,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			audio: {
				duration: 1,
				file_id: "audio-1",
				file_unique_id: "audio-1-unique",
				file_name: "meeting.m4a",
				mime_type: "audio/mp4",
			},
		},
	};
}

function createPrivateDocumentMessageUpdate(options: { fromId: number }): Update {
	return {
		update_id: 6,
		message: {
			message_id: 16,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			document: {
				file_id: "document-1",
				file_unique_id: "document-1-unique",
				file_name: "note.png",
				mime_type: "image/png",
			},
		},
	};
}

function createPrivateVoiceMessageUpdate(options: { fromId: number }): Update {
	return {
		update_id: 7,
		message: {
			message_id: 17,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			voice: {
				duration: 1,
				file_id: "voice-1",
				file_unique_id: "voice-1-unique",
				mime_type: "audio/ogg",
			},
		},
	};
}

function createPrivatePinnedMessageUpdate(options: { fromId: number }): Update {
	return {
		update_id: 3,
		message: {
			message_id: 12,
			date: 1,
			chat: createPrivateChat(options.fromId),
			from: createUser(options.fromId),
			pinned_message: {
				message_id: 13,
				date: 0,
				chat: createPrivateChat(options.fromId),
			},
		},
	};
}

function createPrivateChat(chatId: number) {
	return {
		id: chatId,
		type: "private" as const,
		first_name: `user-${chatId}`,
	};
}

function createUser(id: number, isBot = false) {
	return {
		id,
		is_bot: isBot,
		first_name: isBot ? "Pi Bot" : `user-${id}`,
	};
}
