import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type { PiRuntimeFactory, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import { SessionCoordinator, type SessionCatalogEntry } from "../src/session/session-coordinator.js";
import { chunkText } from "../src/telegram/chunk-text.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import {
	SESSION_SELECTION_CALLBACK_PREFIX,
	SESSION_SELECTION_CANCEL_CALLBACK_DATA,
	SESSION_SELECTION_PAGE_CALLBACK_PREFIX,
	TelegramBotApp,
} from "../src/telegram/telegram-bot-app.js";
import { formatTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const SESSIONS_POPUP_MESSAGE_ID = 700;

const ALPHA_SESSION = createSession({ id: "11111111-alpha", name: "Alpha", isSelected: true });
const BETA_SESSION = createSession({ id: "22222222-beta", name: "Beta" });
const GAMMA_SESSION = createSession({ id: "33333333-gamma", name: "Gamma" });
const DELTA_SESSION = createSession({ id: "44444444-delta", name: "Delta" });
const EPSILON_SESSION = createSession({ id: "55555555-epsilon", name: "Epsilon" });
const ZETA_SESSION = createSession({ id: "66666666-zeta", name: "Zeta" });
const ETA_SESSION = createSession({ id: "77777777-eta", name: "Eta" });
const THETA_SESSION = createSession({ id: "88888888-theta", name: "Theta" });
const IOTA_SESSION = createSession({ id: "99999999-iota", name: "Iota" });
const KAPPA_SESSION = createSession({ id: "aaaaaaaa-kappa", name: "Kappa" });
const LAMBDA_SESSION = createSession({ id: "bbbbbbbb-lambda", name: "Lambda" });

const TWO_PAGE_SESSIONS = [
	ALPHA_SESSION,
	BETA_SESSION,
	GAMMA_SESSION,
	DELTA_SESSION,
	EPSILON_SESSION,
	ZETA_SESSION,
	ETA_SESSION,
];
const THREE_PAGE_SESSIONS = [...TWO_PAGE_SESSIONS, THETA_SESSION, IOTA_SESSION, KAPPA_SESSION, LAMBDA_SESSION];
const ONE_PAGE_SESSIONS = [ALPHA_SESSION, BETA_SESSION, GAMMA_SESSION];

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp /sessions popup behavior", () => {
	it("shows only Next page on the first page and keeps Cancel on the bottom row", async () => {
		const harness = createTelegramBotAppHarness(TWO_PAGE_SESSIONS);

		await harness.handleUpdate(createSessionsCommandUpdate());

		expect(harness.coordinator.listSessionsCalls).toBe(1);
		expect(harness.apiCalls).toHaveLength(1);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: expect.stringContaining("Sessions (page 1/2):"),
				reply_markup: {
					inline_keyboard: [
						[{ text: "current: Alpha", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ALPHA_SESSION.id}`, hide: false }],
						[{ text: "select: Beta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${BETA_SESSION.id}`, hide: false }],
						[{ text: "select: Gamma", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${GAMMA_SESSION.id}`, hide: false }],
						[{ text: "select: Delta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${DELTA_SESSION.id}`, hide: false }],
						[{ text: "select: Epsilon", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${EPSILON_SESSION.id}`, hide: false }],
						[{ text: "Next page", callback_data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}1`, hide: false }],
						[{ text: "cancel", callback_data: SESSION_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Last page");
	});

	it("shows both paging buttons on a middle page and updates the popup in place", async () => {
		const harness = createTelegramBotAppHarness(THREE_PAGE_SESSIONS);

		await harness.handleUpdate(createSessionsCommandUpdate());
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "middle-page-callback",
				data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}1`,
			}),
		);

		expect(harness.coordinator.listSessionsCalls).toBe(2);
		expect(harness.coordinator.switchSessionByIdCalls).toEqual([]);
		expect(harness.apiCalls).toHaveLength(2);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: SESSIONS_POPUP_MESSAGE_ID,
				text: expect.stringContaining("Sessions (page 2/3):"),
				reply_markup: {
					inline_keyboard: [
						[{ text: "select: Zeta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ZETA_SESSION.id}`, hide: false }],
						[{ text: "select: Eta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ETA_SESSION.id}`, hide: false }],
						[{ text: "select: Theta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${THETA_SESSION.id}`, hide: false }],
						[{ text: "select: Iota", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${IOTA_SESSION.id}`, hide: false }],
						[{ text: "select: Kappa", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${KAPPA_SESSION.id}`, hide: false }],
						[
							{ text: "Last page", callback_data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}0`, hide: false },
							{ text: "Next page", callback_data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}2`, hide: false },
						],
						[{ text: "cancel", callback_data: SESSION_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
		expect(harness.apiCalls[1]).toEqual({
			method: "answerCallbackQuery",
			payload: {
				callback_query_id: "middle-page-callback",
				text: undefined,
			},
		});
	});

	it("shows only Last page on the last page", async () => {
		const harness = createTelegramBotAppHarness(TWO_PAGE_SESSIONS);

		await harness.handleUpdate(createSessionsCommandUpdate());
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "last-page-callback",
				data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}1`,
			}),
		);

		expect(harness.coordinator.switchSessionByIdCalls).toEqual([]);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: SESSIONS_POPUP_MESSAGE_ID,
				text: expect.stringContaining("Sessions (page 2/2):"),
				reply_markup: {
					inline_keyboard: [
						[{ text: "select: Zeta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ZETA_SESSION.id}`, hide: false }],
						[{ text: "select: Eta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ETA_SESSION.id}`, hide: false }],
						[{ text: "Last page", callback_data: `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}0`, hide: false }],
						[{ text: "cancel", callback_data: SESSION_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Next page");
	});

	it("omits the paging row entirely when there is only one page", async () => {
		const harness = createTelegramBotAppHarness(ONE_PAGE_SESSIONS);

		await harness.handleUpdate(createSessionsCommandUpdate());

		expect(harness.apiCalls).toHaveLength(1);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Sessions:\n* 1. 11111111 Alpha | 2026-04-24 19:00\n   first message for Alpha\n  2. 22222222 Beta | 2026-04-24 19:00\n   first message for Beta\n  3. 33333333 Gamma | 2026-04-24 19:00\n   first message for Gamma\n\nTap a button below to select a session.",
				reply_markup: {
					inline_keyboard: [
						[{ text: "current: Alpha", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ALPHA_SESSION.id}`, hide: false }],
						[{ text: "select: Beta", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${BETA_SESSION.id}`, hide: false }],
						[{ text: "select: Gamma", callback_data: `${SESSION_SELECTION_CALLBACK_PREFIX}${GAMMA_SESSION.id}`, hide: false }],
						[{ text: "cancel", callback_data: SESSION_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Next page");
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Last page");
	});

	it("dismisses the popup on cancel without switching sessions", async () => {
		const harness = createTelegramBotAppHarness(TWO_PAGE_SESSIONS);

		await harness.handleUpdate(createSessionsCommandUpdate());
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "cancel-callback",
				data: SESSION_SELECTION_CANCEL_CALLBACK_DATA,
			}),
		);

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

	it("resends the selected session's persisted assistant reply after switching", async () => {
		const persistedReply = "# Done\n\n| Col | Val |\n| --- | --- |\n| A | B |";
		const expectedResentPayloadText = formatTelegramMarkdown(chunkText(persistedReply, createAppConfig().telegramChunkSize)[0] ?? "");
		const harness = createTelegramBotAppHarness(TWO_PAGE_SESSIONS, {
			[ZETA_SESSION.path]: persistedReply,
		});

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "switch-callback",
				data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ZETA_SESSION.id}`,
			}),
		);

		expect(harness.coordinator.switchSessionByIdCalls).toEqual([ZETA_SESSION.id]);
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
					text: "Selected session 66666666 (Zeta).",
				}),
			},
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					parse_mode: "MarkdownV2",
				}),
			},
		]);
		const resentReply = harness.apiCalls[2];
		expect(resentReply).toBeDefined();
		expect(resentReply).toEqual({
			method: "sendMessage",
			payload: expect.objectContaining({
				chat_id: CHAT_ID,
				text: expectedResentPayloadText,
				parse_mode: "MarkdownV2",
			}),
		});
	});

	it("stays truthful when the selected session has no persisted assistant reply", async () => {
		const harness = createTelegramBotAppHarness(TWO_PAGE_SESSIONS);

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "empty-switch-callback",
				data: `${SESSION_SELECTION_CALLBACK_PREFIX}${ZETA_SESSION.id}`,
			}),
		);

		expect(harness.apiCalls[harness.apiCalls.length - 1]).toEqual({
			method: "sendMessage",
			payload: expect.objectContaining({
				chat_id: CHAT_ID,
				text: "No persisted assistant reply is available for this session yet.",
			}),
		});
	});
});

function createTelegramBotAppHarness(
	sessions: SessionCatalogEntry[],
	persistedReplies: Record<string, string | undefined> = {},
) {
	const apiCalls: TelegramApiCall[] = [];
	restoreTelegramApi?.();
	restoreTelegramApi = interceptTelegramApi(apiCalls);

	const coordinator = new TestSessionCoordinator(sessions, persistedReplies);
	const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
	const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
	Reflect.set(bot, "botInfo", createBotInfo());

	return {
		apiCalls,
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
		saveModelRecency: async (_workspacePath: string, _modelRecency) => undefined,
		saveScheduledTasks: async (_workspacePath: string, _scheduledTasks) => undefined,
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
		getPersistedUserPromptCount: async (_sessionPath: string) => {
			throw new Error(
				"Unexpected getPersistedUserPromptCount call in TelegramBotApp session selection test.",
			);
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
		firstMessage: overrides.firstMessage ?? `first message for ${overrides.name ?? overrides.id}`,
		allMessagesText: overrides.allMessagesText ?? `all messages for ${overrides.name ?? overrides.id}`,
		isSelected: overrides.isSelected ?? false,
		source: overrides.source ?? "pi",
	};
}

class TestSessionCoordinator extends SessionCoordinator {
	listSessionsCalls = 0;
	switchSessionByIdCalls: string[] = [];

	constructor(
		private readonly sessions: SessionCatalogEntry[],
		private readonly persistedReplies: Record<string, string | undefined>,
	) {
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

	override async getPersistedLastAssistantReply(sessionPath: string): Promise<string | undefined> {
		return this.persistedReplies[sessionPath];
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
