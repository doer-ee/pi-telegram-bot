import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import { ModelNotAvailableError } from "../src/pi/pi-errors.js";
import type { CurrentSessionModelSelection, PiModelDescriptor, PiRuntimeFactory, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import { SessionCoordinator, type SessionCatalogEntry } from "../src/session/session-coordinator.js";
import { BusySessionError } from "../src/session/session-errors.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import {
	MODEL_SELECTION_CANCEL_CALLBACK_DATA,
	MODEL_SELECTION_PAGE_CALLBACK_PREFIX,
	TelegramBotApp,
} from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const MODEL_POPUP_MESSAGE_ID = 700;

const OPENAI_GPT_54 = createModel({ provider: "openai", id: "gpt-5.4" });
const OPENAI_GPT_54_MINI = createModel({ provider: "openai", id: "gpt-5.4-mini" });
const ANTHROPIC_SONNET = createModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
const OPENROUTER_GPT_54 = createModel({ provider: "openrouter", id: "gpt-5.4" });
const GOOGLE_GEMINI = createModel({ provider: "google", id: "gemini-2.5-pro" });
const MISTRAL_MEDIUM = createModel({ provider: "mistral", id: "mistral-medium" });
const XAI_GROK = createModel({ provider: "xai", id: "grok-4" });

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp /model", () => {
	it("shows a paged inline keyboard for auth-configured current-session models", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [
					OPENAI_GPT_54,
					OPENAI_GPT_54_MINI,
					ANTHROPIC_SONNET,
					OPENROUTER_GPT_54,
					GOOGLE_GEMINI,
					MISTRAL_MEDIUM,
					XAI_GROK,
				],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());

		expect(harness.coordinator.getCurrentSessionModelSelectionCalls).toBe(1);
		expect(harness.apiCalls).toHaveLength(1);
		expect(harness.apiCalls[0]).toMatchObject({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Models (page 1/2):\nCurrent: openai/gpt-5.4\n\nTap a button below to switch the current session model.",
				reply_markup: {
					inline_keyboard: [
						[{ text: "current: openai/gpt-5.4", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
						[{ text: "openai/gpt-5.4-mini", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
						[{ text: "anthropic/claude-sonnet-4-5", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
						[{ text: "openrouter/gpt-5.4", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
						[{ text: "google/gemini-2.5-pro", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
						[{ text: "Next page", callback_data: `${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}1`, hide: false }],
						[{ text: "cancel", callback_data: MODEL_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
	});

	it("updates the picker in place when paging", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [
					OPENAI_GPT_54,
					OPENAI_GPT_54_MINI,
					ANTHROPIC_SONNET,
					OPENROUTER_GPT_54,
					GOOGLE_GEMINI,
					MISTRAL_MEDIUM,
					XAI_GROK,
				],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "model-page-callback",
				data: `${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}1`,
			}),
		);

		expect(harness.coordinator.getCurrentSessionModelSelectionCalls).toBe(2);
		expect(harness.apiCalls).toEqual([
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: MODEL_POPUP_MESSAGE_ID,
					text: "Models (page 2/2):\nCurrent: openai/gpt-5.4\n\nTap a button below to switch the current session model.",
					reply_markup: {
						inline_keyboard: [
							[{ text: "mistral/mistral-medium", callback_data: expect.stringContaining("models:select:1:"), hide: false }],
							[{ text: "xai/grok-4", callback_data: expect.stringContaining("models:select:1:"), hide: false }],
							[{ text: "Last page", callback_data: `${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}0`, hide: false }],
							[{ text: "cancel", callback_data: MODEL_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
						],
					},
				},
			},
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "model-page-callback",
					text: undefined,
				},
			},
		]);
	});

	it("switches the current session model, refreshes the picker, and confirms the change", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [OPENAI_GPT_54, ANTHROPIC_SONNET],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());
		const firstResponse = harness.apiCalls[0];
		if (!firstResponse) {
			throw new Error("Expected /model to send an initial picker message.");
		}
		const callbackData = extractCallbackData(firstResponse, 1);
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "model-select-callback",
				data: callbackData,
			}),
		);

		expect(harness.coordinator.setCurrentSessionModelCalls).toEqual([ANTHROPIC_SONNET]);
		expect(harness.apiCalls).toEqual([
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: MODEL_POPUP_MESSAGE_ID,
					text: "Models:\nCurrent: anthropic/claude-sonnet-4-5\n\nTap a button below to switch the current session model.",
					reply_markup: {
						inline_keyboard: [
							[{ text: "openai/gpt-5.4", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
							[{ text: "current: anthropic/claude-sonnet-4-5", callback_data: expect.stringContaining("models:select:0:"), hide: false }],
							[{ text: "cancel", callback_data: MODEL_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
						],
					},
				},
			},
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "model-select-callback",
					text: "Model selected.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Current session model set to anthropic/claude-sonnet-4-5.",
				},
			},
		]);
	});

	it("shows a clear callback failure when a run is already active during model switch", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [OPENAI_GPT_54, ANTHROPIC_SONNET],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());
		const callbackData = extractCallbackDataFromInitialModelPicker(harness, 1);
		harness.coordinator.nextSetCurrentSessionModelError = new BusySessionError();
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "model-busy-callback",
				data: callbackData,
			}),
		);

		expect(harness.coordinator.setCurrentSessionModelCalls).toEqual([ANTHROPIC_SONNET]);
		expect(harness.apiCalls).toEqual([
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "model-busy-callback",
					text: "A Pi run is already active. Abort it before sending another prompt or changing sessions or models.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "A Pi run is already active. Abort it before sending another prompt or changing sessions or models.",
				},
			},
		]);
	});

	it("shows a clear callback failure when the selected model becomes stale before selection is applied", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [OPENAI_GPT_54, ANTHROPIC_SONNET],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());
		const callbackData = extractCallbackDataFromInitialModelPicker(harness, 1);
		harness.coordinator.setSelection({
			currentModel: OPENAI_GPT_54,
			availableModels: [OPENAI_GPT_54],
		});
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "model-stale-callback",
				data: callbackData,
			}),
		);

		expect(harness.coordinator.setCurrentSessionModelCalls).toEqual([]);
		expect(harness.apiCalls).toEqual([
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "model-stale-callback",
					text: "Selected model is no longer available.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Selected model is no longer available.",
				},
			},
		]);
	});

	it("shows a clear callback failure when the Pi bridge rejects the requested model as unavailable", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [OPENAI_GPT_54, ANTHROPIC_SONNET],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());
		const callbackData = extractCallbackDataFromInitialModelPicker(harness, 1);
		harness.coordinator.nextSetCurrentSessionModelError = new ModelNotAvailableError(
			"anthropic/claude-sonnet-4-5",
		);
		harness.apiCalls.length = 0;

		await harness.handleUpdate(
			createCallbackQueryUpdate({
				callbackQueryId: "model-unavailable-callback",
				data: callbackData,
			}),
		);

		expect(harness.coordinator.setCurrentSessionModelCalls).toEqual([ANTHROPIC_SONNET]);
		expect(harness.apiCalls).toEqual([
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "model-unavailable-callback",
					text: "Model not available for this session: anthropic/claude-sonnet-4-5",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Model not available for this session: anthropic/claude-sonnet-4-5",
				},
			},
		]);
	});

	it("shows a truthful empty state when no auth-configured models are available", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: createCurrentSession({ activeModel: OPENAI_GPT_54 }),
			selection: {
				currentModel: OPENAI_GPT_54,
				availableModels: [],
			},
		});

		await harness.handleUpdate(createModelCommandUpdate());

		expect(harness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Models:\nCurrent: openai/gpt-5.4\n\nNo auth-configured models are currently available.",
				},
			},
		]);
	});

	it("shows the existing no-session guidance when no session is selected", async () => {
		const harness = createTelegramBotAppHarness({
			currentSession: undefined,
			selection: undefined,
		});

		await harness.handleUpdate(createModelCommandUpdate());

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
});

function createTelegramBotAppHarness(options: {
	currentSession: SessionCatalogEntry | undefined;
	selection: CurrentSessionModelSelection | undefined;
}) {
	const apiCalls: TelegramApiCall[] = [];
	restoreTelegramApi?.();
	restoreTelegramApi = interceptTelegramApi(apiCalls);

	const coordinator = new TestSessionCoordinator(options.currentSession, options.selection);
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
	let nextMessageId = MODEL_POPUP_MESSAGE_ID;

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
			throw new Error("Unexpected createRuntime call in TelegramBotApp /model test.");
		},
		listSessions: async (_workspacePath: string) => {
			throw new Error("Unexpected listSessions call in TelegramBotApp /model test.");
		},
		getPersistedUserPromptCount: async (_sessionPath: string) => {
			throw new Error("Unexpected getPersistedUserPromptCount call in TelegramBotApp /model test.");
		},
		updateSessionName: async (_sessionPath: string, _name: string) => {
			throw new Error("Unexpected updateSessionName call in TelegramBotApp /model test.");
		},
		refineSessionTitle: async (_request: SessionTitleRefinementRequest) => {
			throw new Error("Unexpected refineSessionTitle call in TelegramBotApp /model test.");
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

function createModelCommandUpdate(): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text: "/model",
			entities: [
				{
					offset: 0,
					length: 6,
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
				message_id: MODEL_POPUP_MESSAGE_ID,
				date: 1,
				chat: createPrivateChat(),
				from: createBotUser(),
				text: "Models:",
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

function createCurrentSession(overrides: Partial<SessionCatalogEntry>): SessionCatalogEntry {
	return {
		path: "/workspace/session.jsonl",
		id: "session-1",
		cwd: "/workspace",
		name: overrides.name,
		activeModel: overrides.activeModel,
		created: overrides.created ?? new Date("2026-04-25T00:00:00.000Z"),
		modified: overrides.modified ?? new Date("2026-04-25T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 0,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText ?? "",
		isSelected: overrides.isSelected ?? true,
		source: overrides.source ?? "pi",
	};
}

function createModel(model: PiModelDescriptor): PiModelDescriptor {
	return model;
}

function extractCallbackDataFromInitialModelPicker(
	harness: ReturnType<typeof createTelegramBotAppHarness>,
	rowIndex: number,
): string {
	const firstResponse = harness.apiCalls[0];
	if (!firstResponse) {
		throw new Error("Expected /model to send an initial picker message.");
	}

	return extractCallbackData(firstResponse, rowIndex);
}

function extractCallbackData(call: TelegramApiCall, rowIndex: number): string {
	const payload = call.payload as {
		reply_markup?: {
			inline_keyboard?: Array<Array<{ callback_data?: string }>>;
		};
	};
	const callbackData = payload.reply_markup?.inline_keyboard?.[rowIndex]?.[0]?.callback_data;
	if (!callbackData) {
		throw new Error(`Missing callback data for row ${rowIndex}.`);
	}
	return callbackData;
}

class TestSessionCoordinator extends SessionCoordinator {
	getCurrentSessionModelSelectionCalls = 0;
	setCurrentSessionModelCalls: PiModelDescriptor[] = [];
	nextSetCurrentSessionModelError: Error | undefined;

	constructor(
		private readonly currentSession: SessionCatalogEntry | undefined,
		private selection: CurrentSessionModelSelection | undefined,
	) {
		super("/workspace", createAppStateStoreStub(), createUnusedRuntimeFactory());
	}

	override async getCurrentSessionModelSelection(): Promise<CurrentSessionModelSelection | undefined> {
		this.getCurrentSessionModelSelectionCalls += 1;
		return this.selection;
	}

	override async setCurrentSessionModel(model: PiModelDescriptor): Promise<SessionCatalogEntry> {
		this.setCurrentSessionModelCalls.push(model);
		if (!this.currentSession || !this.selection) {
			throw new Error("Unexpected model selection without a current session.");
		}

		if (this.nextSetCurrentSessionModelError) {
			const error = this.nextSetCurrentSessionModelError;
			this.nextSetCurrentSessionModelError = undefined;
			throw error;
		}

		this.selection = {
			...this.selection,
			currentModel: model,
		};

		return {
			...this.currentSession,
			activeModel: model,
		};
	}

	setSelection(selection: CurrentSessionModelSelection | undefined): void {
		this.selection = selection;
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
