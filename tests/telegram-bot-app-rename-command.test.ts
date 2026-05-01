import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type { PiRuntimeFactory, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import {
	SessionCoordinator,
	type CurrentSessionEntry,
	type SessionCatalogEntry,
	type PromptObserver,
	type PromptResult,
} from "../src/session/session-coordinator.js";
import { InvalidSessionNameError, NoSelectedSessionError } from "../src/session/session-errors.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import {
	RENAME_CANCEL_CALLBACK_DATA,
	TelegramBotApp,
} from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const RENAME_PROMPT_MESSAGE_ID = 700;

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp /rename", () => {
	it("shows the rename prompt with a cancel button for the selected session", async () => {
		const harness = createTelegramBotAppHarness(
			createCurrentSession({
				created: new Date("2026-04-26T14:05:00.000Z"),
				name: "Debug Telegram formatting",
			}),
		);

		await harness.handleUpdate(createRenameCommandUpdate());

		expect(harness.coordinator.getCurrentSessionCalls).toBe(1);
		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Enter new name for this session\nCurrent: Debug Telegram formatting\nCreated Date/time: 2026-04-26 09:05",
					reply_markup: {
						inline_keyboard: [
							[{ text: "cancel", callback_data: RENAME_CANCEL_CALLBACK_DATA, hide: false }],
						],
					},
				},
			},
		]);
	});

	it("fails clearly when no session is selected", async () => {
		const harness = createTelegramBotAppHarness(undefined);

		await harness.handleUpdate(createRenameCommandUpdate());

		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "No session is selected. Use /new, /sessions, or send a freeform message to create one.",
				},
			},
		]);
	});

	it("consumes the next non-command text as the new session name instead of sending it to Pi", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Old session name" }));

		await harness.handleUpdate(createRenameCommandUpdate());
		await harness.handleUpdate(createTextUpdate("Manual Telegram session title", 2));

		expect(harness.coordinator.renameCurrentSessionCalls).toEqual(["Manual Telegram session title"]);
		expect(harness.coordinator.sendPromptCalls).toEqual([]);
		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					text: expect.stringContaining("Enter new name for this session"),
				}),
			},
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: RENAME_PROMPT_MESSAGE_ID,
					inline_message_id: undefined,
					reply_markup: undefined,
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Current session renamed to: Manual Telegram session title",
				},
			},
		]);
	});

	it("keeps commands working while rename is pending and only consumes the next non-command text", async () => {
		const harness = createTelegramBotAppHarness(
			createCurrentSession({
				name: "Old session name",
				messageCount: 7,
				userPromptCount: 3,
				firstMessage: "Please help me fix Telegram output.",
			}),
		);

		await harness.handleUpdate(createRenameCommandUpdate());
		await harness.handleUpdate(createCurrentCommandUpdate(2));
		await harness.handleUpdate(createTextUpdate("Manual Telegram session title", 3));

		expect(harness.coordinator.renameCurrentSessionCalls).toEqual(["Manual Telegram session title"]);
		expect(harness.coordinator.sendPromptCalls).toEqual([]);
		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					text: expect.stringContaining("Enter new name for this session"),
				}),
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Name: Old session name\nWorkspace: /workspace\nModel: unavailable (not reported by Pi runtime)\nMessages: 3\nFirst Message: Please help me fix Telegram output.",
				},
			},
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: RENAME_PROMPT_MESSAGE_ID,
					inline_message_id: undefined,
					reply_markup: undefined,
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Current session renamed to: Manual Telegram session title",
				},
			},
		]);
	});

	it("rejects blank rename submissions clearly and keeps the rename pending for retry", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Old session name" }));

		await harness.handleUpdate(createRenameCommandUpdate());
		await harness.handleUpdate(createTextUpdate("   ", 2));
		await harness.handleUpdate(createTextUpdate("Manual Telegram session title", 3));

		expect(harness.coordinator.renameCurrentSessionCalls).toEqual(["Manual Telegram session title"]);
		expect(harness.coordinator.sendPromptCalls).toEqual([]);
		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					text: expect.stringContaining("Enter new name for this session"),
				}),
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Session name cannot be blank. Send a non-empty name or tap cancel.",
				},
			},
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: RENAME_PROMPT_MESSAGE_ID,
					inline_message_id: undefined,
					reply_markup: undefined,
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Current session renamed to: Manual Telegram session title",
				},
			},
		]);
	});

	it("cancels the pending rename, dismisses the button, and lets later freeform text go to Pi normally", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Old session name" }));

		await harness.handleUpdate(createRenameCommandUpdate());
		await harness.handleUpdate(createRenameCancelCallbackUpdate());
		await harness.handleUpdate(createTextUpdate("hello after cancel", 3));

		expect(harness.coordinator.renameCurrentSessionCalls).toEqual([]);
		expect(harness.coordinator.sendPromptCalls).toEqual(["hello after cancel"]);
		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: expect.objectContaining({
					chat_id: CHAT_ID,
					text: expect.stringContaining("Enter new name for this session"),
				}),
			},
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: RENAME_PROMPT_MESSAGE_ID,
					inline_message_id: undefined,
					reply_markup: undefined,
				},
			},
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "rename-cancel-callback",
					text: undefined,
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Thinking...",
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: RENAME_PROMPT_MESSAGE_ID + 1,
					inline_message_id: undefined,
					text: "Completed.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "reply:hello after cancel",
					parse_mode: "MarkdownV2",
				},
			},
		]);
	});
});

function createTelegramBotAppHarness(currentSession: CurrentSessionEntry | undefined) {
	const apiCalls: TelegramApiCall[] = [];
	restoreTelegramApi?.();
	restoreTelegramApi = interceptTelegramApi(apiCalls);

	const coordinator = new TestSessionCoordinator(currentSession);
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
	let nextMessageId = RENAME_PROMPT_MESSAGE_ID;

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
		streamThrottleMs: 0,
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
			throw new Error("Unexpected createRuntime call in TelegramBotApp /rename test.");
		},
		listSessions: async (_workspacePath: string) => {
			throw new Error("Unexpected listSessions call in TelegramBotApp /rename test.");
		},
		getPersistedUserPromptCount: async (_sessionPath: string) => {
			throw new Error("Unexpected getPersistedUserPromptCount call in TelegramBotApp /rename test.");
		},
		updateSessionName: async (_sessionPath: string, _name: string) => {
			throw new Error("Unexpected updateSessionName call in TelegramBotApp /rename test.");
		},
		refineSessionTitle: async (_request: SessionTitleRefinementRequest) => {
			throw new Error("Unexpected refineSessionTitle call in TelegramBotApp /rename test.");
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

function createRenameCommandUpdate(updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text: "/rename",
			entities: [
				{
					offset: 0,
					length: 7,
					type: "bot_command",
				},
			],
		},
	};
}

function createCurrentCommandUpdate(updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 11,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text: "/current",
			entities: [
				{
					offset: 0,
					length: 8,
					type: "bot_command",
				},
			],
		},
	};
}

function createTextUpdate(text: string, updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 12,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text,
		},
	};
}

function createRenameCancelCallbackUpdate(): Update {
	return {
		update_id: 2,
		callback_query: {
			id: "rename-cancel-callback",
			chat_instance: "private-chat",
			from: createAuthorizedUser(),
			data: RENAME_CANCEL_CALLBACK_DATA,
			message: {
				message_id: RENAME_PROMPT_MESSAGE_ID,
				date: 1,
				chat: createPrivateChat(),
				from: createBotUser(),
				text: "Enter new name for this session",
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

function createCurrentSession(overrides: Partial<CurrentSessionEntry>): CurrentSessionEntry {
	return {
		path: "/workspace/session.jsonl",
		id: "session-1",
		cwd: "/workspace",
		name: overrides.name,
		activeModel: overrides.activeModel,
		created: overrides.created ?? new Date("2026-04-25T00:00:00.000Z"),
		modified: overrides.modified ?? new Date("2026-04-25T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 0,
		userPromptCount: overrides.userPromptCount ?? 0,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText ?? "",
		isSelected: overrides.isSelected ?? true,
		source: overrides.source ?? "pi",
	};
}

class TestSessionCoordinator extends SessionCoordinator {
	getCurrentSessionCalls = 0;
	renameCurrentSessionCalls: string[] = [];
	sendPromptCalls: string[] = [];

	constructor(private currentSession: CurrentSessionEntry | undefined) {
		super("/workspace", createAppStateStoreStub(), createUnusedRuntimeFactory());
	}

	override async getCurrentSession(): Promise<SessionCatalogEntry | undefined> {
		this.getCurrentSessionCalls += 1;
		return this.currentSession;
	}

	override async getCurrentSessionWithPromptCount(): Promise<CurrentSessionEntry | undefined> {
		return this.currentSession;
	}

	override async renameCurrentSession(name: string): Promise<SessionCatalogEntry> {
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			throw new InvalidSessionNameError();
		}

		if (!this.currentSession) {
			throw new NoSelectedSessionError();
		}

		this.renameCurrentSessionCalls.push(trimmedName);
		this.currentSession = {
			...this.currentSession,
			name: trimmedName,
		};
		return this.currentSession;
	}

	override async sendPrompt(text: string, observer?: PromptObserver): Promise<PromptResult> {
		this.sendPromptCalls.push(text);
		observer?.onAssistantText?.(`reply:${text}`, true);
		return {
			sessionPath: this.currentSession?.path ?? "/workspace/session.jsonl",
			assistantText: `reply:${text}`,
			aborted: false,
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
