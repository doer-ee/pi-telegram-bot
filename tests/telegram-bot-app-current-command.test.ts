import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type { PiRuntimeFactory, SessionTitleRefinementRequest } from "../src/pi/pi-types.js";
import type { ScheduledTaskService } from "../src/scheduler/scheduled-task-service.js";
import type { ParsedScheduleInput } from "../src/scheduler/scheduled-task-types.js";
import {
	type CurrentSessionEntry,
	SessionCoordinator,
	type SessionCatalogEntry,
} from "../src/session/session-coordinator.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import {
	SCHEDULE_CANCEL_CALLBACK_DATA,
	SCHEDULE_CONFIRM_CALLBACK_DATA,
	SCHEDULE_TARGET_CURRENT_CALLBACK_DATA,
	SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA,
	SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX,
	SCHEDULED_TASK_RUN_CONFIRM_CALLBACK_PREFIX,
	SCHEDULED_TASK_RUN_SELECT_CALLBACK_PREFIX,
	SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX,
	SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX,
	TelegramBotApp,
} from "../src/telegram/telegram-bot-app.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const CURRENT_MESSAGE_ID = 700;

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
	vi.useRealTimers();
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

describe("TelegramBotApp scheduler commands", () => {
	it("starts a menu-driven schedule flow", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }));

		await harness.handleUpdate(createCommandUpdate("/schedule"));

		const payload = harness.apiCalls[0]?.payload as { text: string };
		expect(payload.text).toBe("Where should this scheduled prompt run?");
	});

	it("keeps the target step active until the user picks a button or cancels", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }));

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createTextUpdate("tomorrow at 5am"));

		expect(harness.apiCalls).toHaveLength(2);
		expect((harness.apiCalls[0]?.payload as { text: string }).text).toBe("Where should this scheduled prompt run?");
		expect((harness.apiCalls[1]?.payload as { text: string }).text).toBe(
			"Use the buttons to choose new session or current session, or cancel.",
		);
	});

	it("allows typed cancel at the target step", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }));

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createTextUpdate("cancel"));

		expect(harness.apiCalls[1]).toEqual({
			method: "editMessageReplyMarkup",
			payload: {
				chat_id: CHAT_ID,
				message_id: CURRENT_MESSAGE_ID,
				reply_markup: undefined,
			},
		});
		expect(harness.apiCalls[2]).toEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Schedule canceled.",
			},
		});
	});

	it("allows callback cancel after the flow advances to later steps", async () => { const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" })); await harness.handleUpdate(createCommandUpdate("/schedule")); await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA)); await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CANCEL_CALLBACK_DATA)); await harness.handleUpdate(createCommandUpdate("/schedule")); await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA)); await harness.handleUpdate(createTextUpdate("tomorrow at 5am")); await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CANCEL_CALLBACK_DATA)); const cancelMessages = harness.apiCalls.filter((call) => call.method === "sendMessage").map((call) => (call.payload as { text: string }).text).filter((text) => text === "Schedule canceled."); expect(cancelMessages).toEqual(["Schedule canceled.", "Schedule canceled."]); });

it("creates a frozen current-session scheduled task through the menu flow and skips no-op confirmation edits", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-05-01T15:00:00.000Z"));

	const scheduler = new TestScheduledTaskService();
	const currentSession = createCurrentSession({ name: "Selected session" });
	const harness = createTelegramBotAppHarness(currentSession, scheduler, new SchedulerCommandCoordinator(currentSession));

	await harness.handleUpdate(createCommandUpdate("/schedule"));
	await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA));
	await harness.handleUpdate(createTextUpdate("every hour"));

	vi.setSystemTime(new Date("2026-05-01T15:00:30.000Z"));
	await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));
	await harness.handleUpdate(createTextUpdate("Summarize the overnight repo changes"));

	const sendMessageCalls = harness.apiCalls.filter((call) => call.method === "sendMessage");
	expect((sendMessageCalls[0]?.payload as { text: string }).text).toBe("Where should this scheduled prompt run?");
	expect((sendMessageCalls[1]?.payload as { text: string }).text).toContain("When should this run?");
	expect((sendMessageCalls[2]?.payload as { text: string }).text).toContain("I understood this schedule:");
	expect((sendMessageCalls[3]?.payload as { text: string }).text).toContain("What prompt should I send?");
	expect(harness.apiCalls.filter((call) => call.method === "editMessageText")).toHaveLength(0);

	const answerCallbackPayloads = harness.apiCalls
		.filter((call) => call.method === "answerCallbackQuery")
		.map((call) => call.payload as { text?: string });
	expect(answerCallbackPayloads).toContainEqual(expect.objectContaining({ text: "Schedule confirmed." }));

	const clearedKeyboardMessageIds = harness.apiCalls
		.filter((call) => call.method === "editMessageReplyMarkup")
		.map((call) => (call.payload as { message_id: number }).message_id);
	expect(clearedKeyboardMessageIds).toEqual([CURRENT_MESSAGE_ID, CURRENT_MESSAGE_ID + 1, CURRENT_MESSAGE_ID + 2, CURRENT_MESSAGE_ID + 3]);

	expect(scheduler.createdTasks).toHaveLength(1);
	expect(scheduler.createdTasks[0]?.target).toEqual({
		type: "existing_session",
		sessionPath: "/workspace/session.jsonl",
		sessionId: "session-1",
		sessionName: "Selected session",
	});
	expect(scheduler.createdTasks[0]?.prompt).toBe("Summarize the overnight repo changes");
	expect(scheduler.createdTasks[0]?.schedule).toMatchObject({
		kind: "recurring",
		nextRunAt: "2026-05-01T16:00:30.000Z",
		schedule: {
			kind: "recurring",
			rule: {
				type: "interval",
				unit: "hour",
				anchorAt: "2026-05-01T15:00:30.000Z",
			},
		},
	});

	const lastPayload = harness.apiCalls[harness.apiCalls.length - 1]?.payload as { text: string };
	expect(lastPayload.text).toContain("Scheduled task task-2026 created.");
	expect(lastPayload.text).toContain("Target: existing session session-1 (Selected session)");
});

	it("refreshes the confirmation preview so the saved hourly schedule matches the final confirmed schedule", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-01T15:00:00.000Z"));

		const scheduler = new TestScheduledTaskService();
		const currentSession = createCurrentSession({ name: "Selected session" });
		const harness = createTelegramBotAppHarness(currentSession, scheduler, new SchedulerCommandCoordinator(currentSession));

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("every hour"));

		const initialConfirmationPayload = harness.apiCalls.filter((call) => call.method === "sendMessage")[2]?.payload as { text: string };
		expect(initialConfirmationPayload.text).toContain("Next run: 2026-05-01 11:00AM America/Chicago");

		vi.setSystemTime(new Date("2026-05-01T15:10:00.000Z"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));

		const refreshedConfirmationPayload = harness.apiCalls.filter((call) => call.method === "editMessageText")[0]?.payload as { text: string };
		expect(refreshedConfirmationPayload.text).toContain("Next run: 2026-05-01 11:10AM America/Chicago");

		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("Summarize the overnight repo changes"));

		expect(scheduler.createdTasks[0]?.schedule).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T16:10:00.000Z",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "hour",
					anchorAt: "2026-05-01T15:10:00.000Z",
				},
			},
		});
	});

	it("refreshes delayed minute confirmation and then saves the re-anchored five-minute schedule", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-01T15:00:00.000Z"));

		const scheduler = new TestScheduledTaskService();
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("every 5 minutes"));

		const initialConfirmationPayload = harness.apiCalls.filter((call) => call.method === "sendMessage")[2]?.payload as { text: string };
		expect(initialConfirmationPayload.text).toContain("Next run: 2026-05-01 10:05AM America/Chicago");

		vi.setSystemTime(new Date("2026-05-01T15:10:00.000Z"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));

		const refreshedConfirmationPayload = harness.apiCalls.filter((call) => call.method === "editMessageText")[0]?.payload as { text: string };
		expect(refreshedConfirmationPayload.text).toContain("Next run: 2026-05-01 10:15AM America/Chicago");

		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("Summarize the overnight repo changes"));

		expect(scheduler.createdTasks[0]?.schedule).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T15:15:00.000Z",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "minute",
					interval: 5,
					anchorAt: "2026-05-01T15:10:00.000Z",
				},
			},
		});
	});

	it("does not shift day, week, or month schedules when confirmation is delayed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-31T20:15:00.000Z"));

		const scheduler = new TestScheduledTaskService();
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("every month"));

		const initialConfirmationPayload = harness.apiCalls.filter((call) => call.method === "sendMessage")[2]?.payload as { text: string };
		expect(initialConfirmationPayload.text).toContain("Next run: 2026-02-28 2:15PM America/Chicago");

		vi.setSystemTime(new Date("2026-01-31T20:25:00.000Z"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_CONFIRM_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("Summarize the overnight repo changes"));

		expect(scheduler.createdTasks[0]?.schedule).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-02-28T20:15:00.000Z",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "month",
					interval: 1,
					anchorAt: "2026-01-31T20:15:00.000Z",
				},
			},
		});
	});

	it("asks for re-entry when schedule parsing fails instead of guessing", async () => {
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }));

		await harness.handleUpdate(createCommandUpdate("/schedule"));
		await harness.handleUpdate(createCallbackUpdate(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA));
		await harness.handleUpdate(createTextUpdate("sometime soon"));

		const lastPayload = harness.apiCalls[harness.apiCalls.length - 1]?.payload as { text: string };
		expect(lastPayload.text).toContain("Could not understand that schedule in the server local timezone");
		expect(lastPayload.text).toContain("every month");
	});

	it("opens a paginated unschedule menu with five tasks per page and a cancel button", async () => {
		const scheduler = new TestScheduledTaskService(createScheduledTasks(7));
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);

		await harness.handleUpdate(createCommandUpdate("/unschedule"));

		expect(harness.apiCalls[0]).toMatchObject({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: expect.stringContaining("Select a scheduled task to delete (page 1/2):"),
				reply_markup: {
					inline_keyboard: [
						[{ text: "task-0000 | scheduled prompt 0", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${createScheduledTaskToken(scheduler.tasks[0]!)}`, hide: false }],
						[{ text: "task-0001 | scheduled prompt 1", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${createScheduledTaskToken(scheduler.tasks[1]!)}`, hide: false }],
						[{ text: "task-0002 | scheduled prompt 2", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${createScheduledTaskToken(scheduler.tasks[2]!)}`, hide: false }],
						[{ text: "task-0003 | scheduled prompt 3", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${createScheduledTaskToken(scheduler.tasks[3]!)}`, hide: false }],
						[{ text: "task-0004 | scheduled prompt 4", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${createScheduledTaskToken(scheduler.tasks[4]!)}`, hide: false }],
						[{ text: "Next page", callback_data: `${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:1`, hide: false }],
						[{ text: "cancel", callback_data: SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});
		const firstPayload = harness.apiCalls[0]?.payload as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
		expect(firstPayload.reply_markup.inline_keyboard).toHaveLength(7);
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Last page");
	});

	it("shows both page buttons on middle pages and only Last page on the final page", async () => {
		const scheduler = new TestScheduledTaskService(createScheduledTasks(11));
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);

		await harness.handleUpdate(createCommandUpdate("/unschedule"));
		harness.apiCalls.length = 0;

		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:1`, "task-page-middle"));
		expect(harness.apiCalls[0]).toMatchObject({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: CURRENT_MESSAGE_ID,
				text: expect.stringContaining("Select a scheduled task to delete (page 2/3):"),
				reply_markup: {
					inline_keyboard: expect.arrayContaining([
						[
							{ text: "Last page", callback_data: `${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:0`, hide: false },
							{ text: "Next page", callback_data: `${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:2`, hide: false },
						],
					]),
				},
			},
		});

		harness.apiCalls.length = 0;
		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:2`, "task-page-last"));
		expect(harness.apiCalls[0]).toMatchObject({
			method: "editMessageText",
			payload: {
				text: expect.stringContaining("Select a scheduled task to delete (page 3/3):"),
				reply_markup: {
					inline_keyboard: expect.arrayContaining([
						[{ text: "Last page", callback_data: `${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}unschedule:1`, hide: false }],
						[{ text: "cancel", callback_data: SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					]),
				},
			},
		});
		expect(JSON.stringify(harness.apiCalls[0])).not.toContain("Next page");
	});

	it("shows confirmation before unscheduling and deletes the selected task only after confirm", async () => {
		const scheduler = new TestScheduledTaskService();
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);
		const selectedTask = scheduler.tasks[0]!;
		const token = createScheduledTaskToken(selectedTask);

		await harness.handleUpdate(createCommandUpdate("/unschedule"));
		harness.apiCalls.length = 0;
		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}${token}`, "unschedule-select"));

		expect(harness.apiCalls[0]).toMatchObject({
			method: "editMessageText",
			payload: {
				text: expect.stringContaining("Delete this scheduled task?"),
				reply_markup: {
					inline_keyboard: [
						[{ text: "confirm", callback_data: `${SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX}${token}`, hide: false }],
						[{ text: "cancel", callback_data: SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA, hide: false }],
					],
				},
			},
		});

		harness.apiCalls.length = 0;
		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX}${token}`, "unschedule-confirm"));
		expect(scheduler.deletedReferences).toEqual([selectedTask.id]);
		expect(harness.apiCalls).toEqual([
			{
				method: "editMessageReplyMarkup",
				payload: {
					chat_id: CHAT_ID,
					message_id: CURRENT_MESSAGE_ID,
					reply_markup: undefined,
				},
			},
			{
				method: "answerCallbackQuery",
				payload: {
					callback_query_id: "unschedule-confirm",
					text: "Scheduled task deleted.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Deleted scheduled task task-202.",
				},
			},
		]);
	});

	it("runs a selected scheduled task after confirmation and keeps empty states truthful", async () => {
		const scheduler = new TestScheduledTaskService();
		scheduler.runResult = {
			task: scheduler.task,
			delayedByBusy: true,
		};
		const harness = createTelegramBotAppHarness(createCurrentSession({ name: "Selected session" }), scheduler);
		const selectedTask = scheduler.tasks[0]!;
		const token = createScheduledTaskToken(selectedTask);

		await harness.handleUpdate(createCommandUpdate("/runscheduled"));
		harness.apiCalls.length = 0;
		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_RUN_SELECT_CALLBACK_PREFIX}${token}`, "runscheduled-select"));
		await harness.handleUpdate(createCallbackUpdate(`${SCHEDULED_TASK_RUN_CONFIRM_CALLBACK_PREFIX}${token}`, "runscheduled-confirm"));

		expect(scheduler.runReferences).toEqual([selectedTask.id]);
		expect(harness.apiCalls[harness.apiCalls.length - 1]).toEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Scheduled task task-202 will retry at 2026-05-01 3:00PM UTC because a foreground run is active.",
			},
		});

		const emptyHarness = createTelegramBotAppHarness(
			createCurrentSession({ name: "Selected session" }),
			new TestScheduledTaskService([]),
		);
		await emptyHarness.handleUpdate(createCommandUpdate("/runscheduled"));
		expect(emptyHarness.apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "No scheduled tasks.",
				},
			},
		]);
	});
});

function createTelegramBotAppHarness(
	currentSession: CurrentSessionEntry | undefined,
	scheduler: ScheduledTaskService = new TestScheduledTaskService(),
	coordinator: SessionCoordinator = new TestSessionCoordinator(currentSession),
) {
	const apiCalls: TelegramApiCall[] = [];
	restoreTelegramApi?.();
	restoreTelegramApi = interceptTelegramApi(apiCalls);

	const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), scheduler);
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
		saveScheduledTasks: async (_workspacePath: string, _scheduledTasks) => undefined,
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
	return createCommandUpdate("/current");
}

function createCommandUpdate(text: string): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text,
			entities: [
				{
					offset: 0,
					length: text.split(" ")[0]?.length ?? text.length,
					type: "bot_command",
				},
			],
		},
	};
}

function createTextUpdate(text: string): Update {
	return {
		update_id: 2,
		message: {
			message_id: 11,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text,
		},
	};
}

function createCallbackUpdate(data: string, callbackQueryId = "callback-1"): Update {
	return {
		update_id: 3,
		callback_query: {
			id: callbackQueryId,
			from: createAuthorizedUser(),
			chat_instance: "chat-instance",
			data,
			message: {
				message_id: CURRENT_MESSAGE_ID,
				date: 1,
				chat: createPrivateChat(),
				text: "interactive message",
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

	override async getCurrentSession(): Promise<SessionCatalogEntry | undefined> {
		return this.currentSession;
	}

	override async getCurrentSessionWithPromptCount(): Promise<CurrentSessionEntry | undefined> {
		return this.currentSession;
	}
}

class SchedulerCommandCoordinator extends TestSessionCoordinator {
	override async resolveSessionReference(_reference: string): Promise<SessionCatalogEntry> {
		return createCurrentSession({ name: "Selected session" });
	}
}

class TestScheduledTaskService implements ScheduledTaskService {
	readonly task;
	readonly tasks: Array<{
		id: string;
		kind: "one_time";
		prompt: string;
		createdAt: string;
		updatedAt: string;
		nextRunAt: string;
		scheduledForAt: string;
		busyRetryCount: number;
		target: { type: "new_session" };
		schedule: {
			kind: "one_time";
			input: string;
			normalizedText: string;
			timezone: string;
			runAt: string;
		};
	}>;
	createdTasks: Array<{ schedule: { kind: string }; prompt: string; target: unknown }> = [];
	deletedReferences: string[] = [];
	runReferences: string[] = [];
	runResult;

	constructor(tasks = [createScheduledTaskFixture("task-2026", "Summarize the overnight repo changes")]) {
		this.tasks = tasks;
		this.task = tasks[0]!;
		this.runResult = {
			task: this.task,
			delayedByBusy: false,
		};
	}

	async start(): Promise<void> {
		return;
	}

	async stop(): Promise<void> {
		return;
	}

	async createTask(input: { schedule: ParsedScheduleInput; prompt: string; target: unknown }) {
		this.createdTasks.push(input);
		return {
			...this.task,
			kind: input.schedule.kind,
			nextRunAt: input.schedule.nextRunAt,
			scheduledForAt: input.schedule.nextRunAt,
			prompt: input.prompt,
			target: input.target as typeof this.task.target,
			schedule: input.schedule.schedule,
		};
	}

	async listTasks() {
		return this.tasks;
	}

	async deleteTaskByReference(reference: string) {
		this.deletedReferences.push(reference);
		return this.tasks.find((task) => task.id === reference) ?? this.task;
	}

	async runTaskNowByReference(reference: string) {
		this.runReferences.push(reference);
		const task = this.tasks.find((entry) => entry.id === reference) ?? this.task;
		return {
			...this.runResult,
			task,
		};
	}
}

function createScheduledTaskFixture(id: string, prompt: string) {
	return {
		id,
		kind: "one_time" as const,
		prompt,
		createdAt: "2026-05-01T14:00:00.000Z",
		updatedAt: "2026-05-01T14:00:00.000Z",
		nextRunAt: "2026-05-01T15:00:00.000Z",
		scheduledForAt: "2026-05-01T15:00:00.000Z",
		busyRetryCount: 0,
		target: { type: "new_session" as const },
		schedule: {
			kind: "one_time" as const,
			input: "2026-05-01 3:00pm",
			normalizedText: "One time at 2026-05-01 3:00PM UTC",
			timezone: "UTC",
			runAt: "2026-05-01T15:00:00.000Z",
		},
	};
}

function createScheduledTasks(count: number) {
	return Array.from({ length: count }, (_, index) =>
		createScheduledTaskFixture(`task-${String(index).padStart(4, "0")}`, `scheduled prompt ${index}`),
	);
}

function createScheduledTaskToken(task: { id: string }): string {
	return createHash("sha256").update(task.id).digest("hex").slice(0, 12);
}

interface TelegramApiCall {
	method: string;
	payload: unknown;
}

interface InternalTelegrafBot {
	handleUpdate(update: Update): Promise<void>;
	botInfo?: unknown;
}
