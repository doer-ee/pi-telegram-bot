import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type { PiRuntimeFactory, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import {
	SessionCoordinator,
	type CurrentSessionEntry,
} from "../src/session/session-coordinator.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import { TelegramBotApp } from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const CURRENT_MESSAGE_ID = 700;

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp /current", () => {
	it("shows Messages as the narrow persisted user prompt count instead of the broad session message count", async () => {
		const harness = createTelegramBotAppHarness(
			createCurrentSession({
				name: "Prompt counting",
				messageCount: 7,
				userPromptCount: 3,
				firstMessage: "Please help me fix Telegram output.",
			}),
		);

		await harness.handleUpdate(createCurrentCommandUpdate());

		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Name: Prompt counting\nWorkspace: /workspace\nModel: unavailable (not reported by Pi runtime)\nMessages: 3\nFirst Message: Please help me fix Telegram output.",
				},
			},
		]);
	});

	it("shows a truthful unavailable marker when the selected session prompt count cannot be read", async () => {
		const harness = createTelegramBotAppHarness(
			createCurrentSession({
				name: "Unreadable session",
				messageCount: 9,
				userPromptCount: undefined,
				firstMessage: "Please help me fix Telegram output.",
			}),
		);

		await harness.handleUpdate(createCurrentCommandUpdate());

		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Name: Unreadable session\nWorkspace: /workspace\nModel: unavailable (not reported by Pi runtime)\nMessages: unavailable (could not read persisted user prompts)\nFirst Message: Please help me fix Telegram output.",
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
		handleUpdate(update: Update): Promise<void> {
			return bot.handleUpdate(update);
		},
	};
}

function interceptTelegramApi(apiCalls: TelegramApiCall[]): () => void {
	const originalCallApi = Telegram.prototype.callApi;
	let nextMessageId = CURRENT_MESSAGE_ID;

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
	};
}

function createUnusedRuntimeFactory(): PiRuntimeFactory {
	return {
		createRuntime: async (_options: { workspacePath: string; selectedSessionPath?: string }) => {
			throw new Error("Unexpected createRuntime call in TelegramBotApp /current test.");
		},
		listSessions: async (_workspacePath: string) => {
			throw new Error("Unexpected listSessions call in TelegramBotApp /current test.");
		},
		getPersistedUserPromptCount: async (_sessionPath: string) => {
			throw new Error("Unexpected getPersistedUserPromptCount call in TelegramBotApp /current test.");
		},
		updateSessionName: async (_sessionPath: string, _name: string) => {
			throw new Error("Unexpected updateSessionName call in TelegramBotApp /current test.");
		},
		refineSessionTitle: async (_request: SessionTitleRefinementRequest) => {
			throw new Error("Unexpected refineSessionTitle call in TelegramBotApp /current test.");
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

function createCurrentCommandUpdate(): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
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
		userPromptCount: overrides.userPromptCount,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText ?? "",
		isSelected: overrides.isSelected ?? true,
		source: overrides.source ?? "pi",
	};
}

class TestSessionCoordinator extends SessionCoordinator {
	constructor(private readonly currentSession: CurrentSessionEntry | undefined) {
		super("/workspace", createAppStateStoreStub(), createUnusedRuntimeFactory());
	}

	override async getCurrentSessionWithPromptCount(): Promise<CurrentSessionEntry | undefined> {
		return this.currentSession;
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
