import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type { SessionInfoRecord, PiRuntimeFactory, PiRuntimePort, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import { SessionCoordinator, type SessionCatalogEntry } from "../src/session/session-coordinator.js";
import { createEmptyAppState, type AppStateStore, type StoredBotOwnedSessionPin, type StoredSelectedSession } from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import {
	SESSION_SELECTION_CANCEL_CALLBACK_DATA,
	TelegramBotApp,
} from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const SESSIONS_POPUP_MESSAGE_ID = 700;

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp /sessions popup behavior", () => {
	it("sends a /sessions popup containing a cancel button", async () => {
		const harness = createTelegramBotAppHarness();

		await harness.handleUpdate(createSessionsCommandUpdate());

		expect(harness.coordinator.listSessionsCalls).toBe(1);
		expect(harness.apiCalls).toHaveLength(1);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				reply_markup: {
					inline_keyboard: [
						[{ text: "current: Alpha", callback_data: `switch:${CURRENT_SESSION.id}`, hide: false }],
						[{ text: "switch: Beta", callback_data: `switch:${OTHER_SESSION.id}`, hide: false }],
						[{ text: "cancel", callback_data: SESSION_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
	});

	it("dismisses the popup on cancel without switching sessions", async () => {
		const harness = createTelegramBotAppHarness();

		await harness.handleUpdate(createSessionsCommandUpdate());
		harness.apiCalls.length = 0;

		await harness.handleUpdate(createCancelCallbackUpdate());

		expect(harness.coordinator.switchSessionByIdCalls).toEqual([]);
		expect(harness.apiCalls).toEqual([
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: SESSIONS_POPUP_MESSAGE_ID,
					inline_message_id: undefined,
					reply_markup: undefined,
				},
			},
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "cancel-callback",
					text: undefined,
				},
			},
		]);
	});

	it("keeps the existing switch callback flow working", async () => {
		const harness = createTelegramBotAppHarness();

		await harness.handleUpdate(createSwitchCallbackUpdate(OTHER_SESSION.id));

		expect(harness.coordinator.switchSessionByIdCalls).toEqual([OTHER_SESSION.id]);
		expect(harness.apiCalls).toEqual([
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "switch-callback",
					text: "Session selected.",
				},
			},
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					text: "Selected session 22222222 (Beta).",
				}),
			},
		]);
	});
});

const CURRENT_SESSION = createSession({
	id: "11111111-alpha",
	name: "Alpha",
	isSelected: true,
});
const OTHER_SESSION = createSession({
	id: "22222222-beta",
	name: "Beta",
});

function createTelegramBotAppHarness() {
	const apiCalls: TelegramApiCall[] = [];
	restoreTelegramApi?.();
	restoreTelegramApi = interceptTelegramApi(apiCalls);

	const coordinator = new TestSessionCoordinator([CURRENT_SESSION, OTHER_SESSION]);
	const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
	const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
	Reflect.set(bot, "botInfo", createBotInfo());

	return {
		apiCalls,
		app,
		bot,
		coordinator,
		handleUpdate(update: Update): Promise<void> {
			return bot.handleUpdate(update);
		},
	};
}

function interceptTelegramApi(apiCalls: TelegramApiCall[]): () => void {
	const originalCallApi = Telegram.prototype.callApi;
	let nextMessageId = SESSIONS_POPUP_MESSAGE_ID;

	Reflect.set(Telegram.prototype, "callApi", async (method: string, payload: unknown) => {
		apiCalls.push({ method, payload });
		if (method === "sendMessage") {
			return { message_id: nextMessageId++ };
		}
		return true;
	});

	return () => {
		Reflect.set(Telegram.prototype, "callApi", originalCallApi);
	};
}

function createAppConfig(): AppConfig {
	return {
		telegramBotToken: "test-token",
		authorizedTelegramUserId: AUTHORIZED_USER_ID,
		workspacePath: "/workspace",
		statePath: "/workspace/state.json",
		agentDir: undefined,
		titleRefinementModel: "test-model",
		streamThrottleMs: 1000,
		telegramChunkSize: 3500,
	};
}

function createSessionPinSync(): SessionPinSync {
	return new SessionPinSync(createTelegramMessageClientStub(), createAppStateStoreStub(), "/workspace", CHAT_ID);
}

function createTelegramMessageClientStub() {
	return {
		sendText: async (_chatId: number, _text: string) => 1,
		editText: async (_chatId: number, _messageId: number, _text: string) => undefined,
		deleteText: async (_chatId: number, _messageId: number) => undefined,
		pinText: async (_chatId: number, _messageId: number) => undefined,
		unpinText: async (_chatId: number, _messageId: number) => undefined,
	};
}

function createAppStateStoreStub(): AppStateStore {
	return {
		load: async (workspacePath: string) => createEmptyAppState(workspacePath),
		saveSelectedSession: async (_workspacePath: string, _selectedSession: StoredSelectedSession) => undefined,
		clearSelectedSession: async (_workspacePath: string) => undefined,
		saveBotOwnedSessionPin: async (_workspacePath: string, _botOwnedSessionPin: StoredBotOwnedSessionPin) => undefined,
		clearBotOwnedSessionPin: async (_workspacePath: string) => undefined,
	};
}

function createUnusedRuntimeFactory(): PiRuntimeFactory {
	return {
		createRuntime: async (_options: { workspacePath: string; selectedSessionPath?: string }) => {
			throw new Error("Unexpected createRuntime call in TelegramBotApp session selection test.");
		},
		listSessions: async (_workspacePath: string) => {
			throw new Error("Unexpected listSessions call on runtime factory in TelegramBotApp session selection test.");
		},
		updateSessionName: async (_sessionPath: string, _name: string) => {
			throw new Error("Unexpected updateSessionName call in TelegramBotApp session selection test.");
		},
		refineSessionTitle: async (_request: SessionTitleRefinementRequest) => {
			throw new Error("Unexpected refineSessionTitle call in TelegramBotApp session selection test.");
		},
	};
}

function createBotInfo() {
	return {
		id: BOT_ID,
		is_bot: true,
		first_name: "Pi Test Bot",
		username: BOT_USERNAME,
		can_join_groups: false,
		can_read_all_group_messages: false,
		supports_inline_queries: false,
	};
}

function createSessionsCommandUpdate(): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text: "/sessions",
			entities: [
				{
					offset: 0,
					length: 9,
					type: "bot_command",
				},
			],
		},
	};
}

function createCancelCallbackUpdate(): Update {
	return createCallbackQueryUpdate({
		callbackQueryId: "cancel-callback",
		data: SESSION_SELECTION_CANCEL_CALLBACK_DATA,
	});
}

function createSwitchCallbackUpdate(sessionId: string): Update {
	return createCallbackQueryUpdate({
		callbackQueryId: "switch-callback",
		data: `switch:${sessionId}`,
	});
}

function createCallbackQueryUpdate(options: { callbackQueryId: string; data: string }): Update {
	return {
		update_id: 2,
		callback_query: {
			id: options.callbackQueryId,
			chat_instance: "private-chat",
			from: createAuthorizedUser(),
			data: options.data,
			message: {
				message_id: SESSIONS_POPUP_MESSAGE_ID,
				date: 1,
				chat: createPrivateChat(),
				from: createBotUser(),
				text: "Sessions:",
			},
		},
	};
}

function createPrivateChat() {
	return {
		id: CHAT_ID,
		type: "private" as const,
		first_name: "authorized-user",
	};
}

function createAuthorizedUser() {
	return {
		id: AUTHORIZED_USER_ID,
		is_bot: false,
		first_name: "authorized-user",
	};
}

function createBotUser() {
	return {
		id: BOT_ID,
		is_bot: true,
		first_name: "Pi Test Bot",
		username: BOT_USERNAME,
	};
}

function createSession(overrides: Partial<SessionCatalogEntry> & Pick<SessionCatalogEntry, "id">): SessionCatalogEntry {
	return {
		path: overrides.path ?? `/workspace/${overrides.id}.json`,
		id: overrides.id,
		cwd: overrides.cwd ?? "/workspace",
		name: overrides.name,
		created: overrides.created ?? new Date("2026-04-25T00:00:00.000Z"),
		modified: overrides.modified ?? new Date("2026-04-25T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
		isSelected: overrides.isSelected ?? false,
		source: overrides.source ?? "pi",
	};
}

class TestSessionCoordinator extends SessionCoordinator {
	listSessionsCalls = 0;
	switchSessionByIdCalls: string[] = [];

	constructor(private readonly sessions: SessionCatalogEntry[]) {
		super("/workspace", createAppStateStoreStub(), createUnusedRuntimeFactory());
	}

	override async listSessions(): Promise<SessionCatalogEntry[]> {
		this.listSessionsCalls += 1;
		return this.sessions;
	}

	override async switchSessionById(sessionId: string): Promise<SessionCatalogEntry> {
		this.switchSessionByIdCalls.push(sessionId);
		const session = this.sessions.find((entry) => entry.id === sessionId);
		if (!session) {
			throw new Error(`Unexpected session switch request for ${sessionId}.`);
		}
		return {
			...session,
			isSelected: true,
		};
	}
}

interface TelegramApiCall {
	method: string;
	payload: unknown;
}

interface InternalTelegrafBot {
	handleUpdate(update: Update): Promise<void>;
	botInfo?: unknown;
}
