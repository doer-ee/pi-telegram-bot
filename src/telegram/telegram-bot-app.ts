import { createHash } from "node:crypto";
import { Markup, Telegraf, type Context } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../config/app-config.js";
import { ModelNotAvailableError } from "../pi/pi-errors.js";
import type { CurrentSessionModelSelection, PiModelDescriptor } from "../pi/pi-types.js";
import {
	createDeterministicScheduleInputParser,
	type ScheduleInputParser,
} from "../scheduler/schedule-ai-parser.js";
import {
	doesParsedScheduleRequireConfirmationRefresh,
} from "../scheduler/schedule-parser.js";
import { getServerTimezone } from "../scheduler/schedule-time.js";
import type { ScheduledTaskService } from "../scheduler/scheduled-task-service.js";
import type { ParsedScheduleInput, ScheduledTask, ScheduledTaskTarget } from "../scheduler/scheduled-task-types.js";
import {
	BusySessionError,
	InvalidSessionNameError,
	NoSelectedSessionError,
	SelectedModelUnavailableError,
	SessionNotFoundError,
} from "../session/session-errors.js";
import {
	type SessionCatalogEntry,
	SessionCoordinator,
} from "../session/session-coordinator.js";
import {
	formatCurrentSessionText,
	formatHelpText,
	formatModelSelectionChangedText,
	formatModelSelectionText,
	formatNewSessionText,
	formatNoAvailableModelsText,
	formatNoSelectedSessionText,
	formatRenameConfirmationText,
	formatRenamePromptText,
	formatScheduleAwaitingConfirmationText,
	formatScheduleConfirmationText,
	formatSchedulePromptText,
	formatScheduleTargetGuidanceText,
	formatScheduleTargetPromptText,
	formatScheduleWhenPromptText,
	formatScheduledTaskActionConfirmationText,
	formatScheduledTaskCreatedText,
	formatScheduledTaskDeletedText,
	formatScheduledTaskRunQueuedText,
	formatScheduledTaskSelectionText,
	formatScheduledTasksText,
	formatSelectionChangedText,
	formatSessionsText,
	formatStartText,
	formatStatusText,
} from "./telegram-formatters.js";
import { registerTelegramBotCommands } from "./telegram-command-definitions.js";
import { createTelegramMessageClient } from "./telegram-message-client.js";
import { TelegramReplyStreamer } from "./telegram-reply-streamer.js";
import { SessionPinSync } from "./session-pin-sync.js";
import { sendStandaloneTelegramText } from "./send-telegram-text.js";

type BotContext = Context<Update>;
type MessageUpdate = Extract<Update, { message: unknown }>;
type EditedMessageUpdate = Extract<Update, { edited_message: unknown }>;
type CallbackQueryUpdate = Extract<Update, { callback_query: unknown }>;
type InteractiveMessage = MessageUpdate["message"] | EditedMessageUpdate["edited_message"];

const INTERACTIVE_MESSAGE_KEYS = [
	"animation",
	"audio",
	"contact",
	"dice",
	"document",
	"game",
	"location",
	"photo",
	"poll",
	"sticker",
	"story",
	"text",
	"venue",
	"video",
	"video_note",
	"voice",
] as const;

export const SESSION_SELECTION_CALLBACK_PREFIX = "sessions:select:";
export const SESSION_SELECTION_PAGE_CALLBACK_PREFIX = "sessions:page:";
export const SESSION_SELECTION_CANCEL_CALLBACK_DATA = "sessions:cancel";
export const SESSION_CLEAR_ALL_CALLBACK_DATA = "sessions:clear-all";
export const SESSION_CLEAR_ALL_CONFIRM_CALLBACK_DATA = "sessions:clear-all:confirm";
const SESSION_SELECTION_PAGE_SIZE = 5;
export const MODEL_SELECTION_PAGE_CALLBACK_PREFIX = "models:page:";
export const MODEL_SELECTION_CANCEL_CALLBACK_DATA = "models:cancel";
export const MODEL_SWITCH_CALLBACK_PREFIX = "models:select:";
const MODEL_SELECTION_PAGE_SIZE = 5;
export const RENAME_CANCEL_CALLBACK_DATA = "rename:cancel";
export const SCHEDULE_TARGET_NEW_CALLBACK_DATA = "schedule:target:new";
export const SCHEDULE_TARGET_CURRENT_CALLBACK_DATA = "schedule:target:current";
export const SCHEDULE_CONFIRM_CALLBACK_DATA = "schedule:confirm";
export const SCHEDULE_CANCEL_CALLBACK_DATA = "schedule:cancel";
export const SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX = "scheduled:page:";
export const SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA = "scheduled:cancel";
export const SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX = "scheduled:unschedule:select:";
export const SCHEDULED_TASK_RUN_SELECT_CALLBACK_PREFIX = "scheduled:run:select:";
export const SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX = "scheduled:unschedule:confirm:";
export const SCHEDULED_TASK_RUN_CONFIRM_CALLBACK_PREFIX = "scheduled:run:confirm:";
const SCHEDULED_TASK_SELECTION_PAGE_SIZE = 5;

type ScheduledTaskMenuAction = "unschedule" | "runscheduled";

interface PendingRenameState {
	promptMessageId: number;
}

type PendingScheduleState =
	| {
			step: "target";
			promptMessageId: number;
	  }
	| {
			step: "when";
			promptMessageId: number;
			target: ScheduledTaskTarget;
	  }
	| {
			step: "confirm";
			promptMessageId: number;
			target: ScheduledTaskTarget;
			schedule: ParsedScheduleInput;
	  }
	| {
			step: "prompt";
			promptMessageId: number;
			target: ScheduledTaskTarget;
			schedule: ParsedScheduleInput;
	  };

function createNoopScheduledTaskService(): ScheduledTaskService {
	return {
		start: async () => undefined,
		stop: async () => undefined,
		createTask: async () => {
			throw new Error("Scheduler is not configured.");
		},
		listTasks: async () => {
			throw new Error("Scheduler is not configured.");
		},
		deleteTaskByReference: async () => {
			throw new Error("Scheduler is not configured.");
		},
		runTaskNowByReference: async () => {
			throw new Error("Scheduler is not configured.");
		},
	};
}

export class TelegramBotApp {
	private readonly bot: Telegraf<BotContext>;
	private readonly sessionPinSync: SessionPinSync;
	private removeActiveSessionObserver: (() => void) | undefined;
	private pendingRename: PendingRenameState | undefined;
	private started = false;
	constructor(
		private readonly config: AppConfig,
		private readonly coordinator: SessionCoordinator,
		sessionPinSync: SessionPinSync,
		private readonly scheduler: ScheduledTaskService = createNoopScheduledTaskService(),
		private readonly scheduleInputParser: ScheduleInputParser = createDeterministicScheduleInputParser(),
	) {
		this.bot = new Telegraf<BotContext>(config.telegramBotToken);
		this.sessionPinSync = sessionPinSync;
		this.registerHandlers();
	}
	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		await this.coordinator.initialize();
		await this.sessionPinSync.initialize();
		this.removeActiveSessionObserver?.();
		this.removeActiveSessionObserver = this.coordinator.addActiveSessionObserver({
			onActiveSessionUpdated: async (session) => {
				await this.sessionPinSync.syncActiveSession(session);
			},
		});
		await this.sessionPinSync.syncActiveSession(await this.coordinator.getCurrentSession());
		await this.scheduler.start();
		await registerTelegramBotCommands(this.bot.telegram);
		await this.bot.launch();
		this.started = true;
	}
	async stop(reason = "shutdown"): Promise<void> {
		if (this.started) {
			this.bot.stop(reason);
			this.started = false;
		}
		this.removeActiveSessionObserver?.();
		this.removeActiveSessionObserver = undefined;
		await this.scheduler.stop();
		await this.coordinator.dispose();
	}
	private registerHandlers(): void {
		this.bot.use(async (ctx, next) => {
			if (this.isAuthorizedPrivateMessage(ctx)) {
				await next();
				return;
			}

			if (shouldRejectUnauthorizedPrivateUpdate(ctx.update, this.config.authorizedTelegramUserId)) {
				await ctx.reply("Unauthorized user.");
			}
		});

		this.bot.start(async (ctx) => {
			await ctx.reply(formatStartText(await this.coordinator.getStatus()));
		});

		this.bot.command("help", async (ctx) => {
			await ctx.reply(formatHelpText());
		});

		this.bot.command("status", async (ctx) => {
			await ctx.reply(formatStatusText(await this.coordinator.getStatus()));
		});

		this.bot.command("new", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const session = await this.coordinator.createNewSession();
				await ctx.reply(formatNewSessionText(session));
			});
		});

		this.bot.command("sessions", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const sessions = await this.coordinator.listSessions();
				const popup = buildSessionSelectionPopup(sessions);
				if (popup.keyboard) {
					await ctx.reply(popup.text, popup.keyboard);
					return;
				}
				await ctx.reply(popup.text);
			});
		});

		this.bot.command("current", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				await ctx.reply(formatCurrentSessionText(await this.coordinator.getCurrentSessionWithPromptCount()));
			});
		});

		this.bot.command("rename", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const session = await this.coordinator.getCurrentSession();
				if (!session) {
					throw new NoSelectedSessionError();
				}
				if (this.pendingSchedule) {
					await this.dismissInlineKeyboard(ctx.chat.id, this.pendingSchedule.promptMessageId);
					this.pendingSchedule = undefined;
				}

				const promptMessage = await ctx.reply(formatRenamePromptText(session), buildRenameKeyboard());
				this.pendingRename = {
					promptMessageId: promptMessage.message_id,
				};
			});
		});

		this.bot.command("model", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const selection = await this.coordinator.getCurrentSessionModelSelection();
				if (!selection) {
					await ctx.reply(formatNoSelectedSessionText());
					return;
				}

				const popup = buildModelSelectionPopup(selection);
				if (popup.keyboard) {
					await ctx.reply(popup.text, popup.keyboard);
					return;
				}
				await ctx.reply(popup.text);
			});
		});

		this.bot.command("abort", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const aborted = await this.coordinator.abortActiveRun();
				await ctx.reply(aborted ? "Abort requested." : "No active run to abort.");
			});
		});

		this.bot.command("schedule", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				if (this.pendingRename) {
					await this.dismissInlineKeyboard(ctx.chat.id, this.pendingRename.promptMessageId);
					this.pendingRename = undefined;
				}
				if (this.pendingSchedule) {
					await this.dismissInlineKeyboard(ctx.chat.id, this.pendingSchedule.promptMessageId);
				}
				const promptMessage = await ctx.reply(formatScheduleTargetPromptText(), buildScheduleTargetKeyboard());
				this.pendingSchedule = {
					step: "target",
					promptMessageId: promptMessage.message_id,
				};
			});
		});

		this.bot.command("schedules", async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				await ctx.reply(formatScheduledTasksText(await this.scheduler.listTasks()));
			});
		});

		this.bot.command("unschedule", async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const popup = buildScheduledTaskSelectionPopup(await this.scheduler.listTasks(), "unschedule");
		if (popup.keyboard) {
			await ctx.reply(popup.text, popup.keyboard);
			return;
		}
		await ctx.reply(popup.text);
	});
});

		this.bot.command("runscheduled", async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const popup = buildScheduledTaskSelectionPopup(await this.scheduler.listTasks(), "runscheduled");
		if (popup.keyboard) {
			await ctx.reply(popup.text, popup.keyboard);
			return;
		}
		await ctx.reply(popup.text);
	});
});

		this.bot.action(new RegExp(`^${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}(unschedule|runscheduled):(\\d+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const action = toScheduledTaskMenuAction(ctx.match[1]);
		const pageIndex = parseScheduledTaskSelectionPageIndex(ctx.match[2]);
		const popup = buildScheduledTaskSelectionPopup(await this.scheduler.listTasks(), action, pageIndex);
		if (popup.keyboard) {
			await ctx.editMessageText(popup.text, popup.keyboard);
		} else {
			await ctx.editMessageText(popup.text);
		}
		await ctx.answerCbQuery();
	});
});

this.bot.action(SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA, async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		await dismissSessionSelectionKeyboard(ctx);
	});
});

this.bot.action(new RegExp(`^${SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX}([a-f0-9]+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const task = requireScheduledTaskSelection(await this.scheduler.listTasks(), ctx.match[1]);
		await ctx.editMessageText(
			formatScheduledTaskActionConfirmationText(task, "unschedule"),
			buildScheduledTaskConfirmationKeyboard("unschedule", task),
		);
		await ctx.answerCbQuery("Task selected.");
	});
});

this.bot.action(new RegExp(`^${SCHEDULED_TASK_RUN_SELECT_CALLBACK_PREFIX}([a-f0-9]+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const task = requireScheduledTaskSelection(await this.scheduler.listTasks(), ctx.match[1]);
		await ctx.editMessageText(
			formatScheduledTaskActionConfirmationText(task, "runscheduled"),
			buildScheduledTaskConfirmationKeyboard("runscheduled", task),
		);
		await ctx.answerCbQuery("Task selected.");
	});
});

this.bot.action(new RegExp(`^${SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX}([a-f0-9]+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const task = requireScheduledTaskSelection(await this.scheduler.listTasks(), ctx.match[1]);
		const callbackMessage = ctx.callbackQuery.message;
		const chatId = callbackMessage?.chat.id;
		const messageId = callbackMessage?.message_id;
		if (chatId === undefined || !messageId) {
			throw new Error("Could not continue the scheduled task flow.");
		}

		await this.dismissInlineKeyboard(chatId, messageId);
		await ctx.answerCbQuery("Scheduled task deleted.");
		await ctx.reply(formatScheduledTaskDeletedText(await this.scheduler.deleteTaskByReference(task.id)));
	});
});

this.bot.action(new RegExp(`^${SCHEDULED_TASK_RUN_CONFIRM_CALLBACK_PREFIX}([a-f0-9]+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const task = requireScheduledTaskSelection(await this.scheduler.listTasks(), ctx.match[1]);
		const callbackMessage = ctx.callbackQuery.message;
		const chatId = callbackMessage?.chat.id;
		const messageId = callbackMessage?.message_id;
		if (chatId === undefined || !messageId) {
			throw new Error("Could not continue the scheduled task flow.");
		}

		await this.dismissInlineKeyboard(chatId, messageId);
		const result = await this.scheduler.runTaskNowByReference(task.id);
		await ctx.answerCbQuery("Scheduled task queued.");
		await ctx.reply(formatScheduledTaskRunQueuedText(result.task, result.delayedByBusy));
	});
});

this.bot.action(new RegExp(`^${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
	await this.runWithErrorHandling(ctx, async () => {
		const pageIndex = parseSessionSelectionPageIndex(ctx.match[1]);
		const sessions = await this.coordinator.listSessions();
		const popup = buildSessionSelectionPopup(sessions, pageIndex);
		if (popup.keyboard) {
			await ctx.editMessageText(popup.text, popup.keyboard);
		} else {
			await ctx.editMessageText(popup.text);
		}
		await ctx.answerCbQuery();
	});
});

		this.bot.action(SESSION_SELECTION_CANCEL_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				await dismissSessionSelectionKeyboard(ctx);
			});
		});

		this.bot.action(SESSION_CLEAR_ALL_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				await ctx.editMessageText(
					buildClearAllSessionsConfirmationText(),
					buildClearAllSessionsConfirmationKeyboard(),
				);
				await ctx.answerCbQuery("Confirm clear all sessions.");
			});
		});

		this.bot.action(SESSION_CLEAR_ALL_CONFIRM_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const callbackMessage = ctx.callbackQuery.message;
				const chatId = callbackMessage?.chat.id;
				const messageId = callbackMessage?.message_id;
				if (chatId === undefined || !messageId) {
					throw new Error("Could not continue the clear-all-sessions flow.");
				}

				await this.dismissInlineKeyboard(chatId, messageId);
				const session = await this.coordinator.clearAllSessions();
				await ctx.answerCbQuery("All sessions cleared.");
				await ctx.reply("Cleared all persisted Pi sessions for this workspace.");
				await ctx.reply(formatNewSessionText(session));
			});
		});

		this.bot.action(new RegExp(`^${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const selection = await this.coordinator.getCurrentSessionModelSelection();
				if (!selection) {
					throw new NoSelectedSessionError();
				}

				const pageIndex = parseModelSelectionPageIndex(ctx.match[1]);
				const popup = buildModelSelectionPopup(selection, pageIndex);
				if (popup.keyboard) {
					await ctx.editMessageText(popup.text, popup.keyboard);
				} else {
					await ctx.editMessageText(popup.text);
				}
				await ctx.answerCbQuery();
			});
		});

		this.bot.action(MODEL_SELECTION_CANCEL_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				await dismissSessionSelectionKeyboard(ctx);
			});
		});

		this.bot.action(RENAME_CANCEL_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				if (ctx.callbackQuery.message?.message_id === this.pendingRename?.promptMessageId) {
					this.pendingRename = undefined;
				}
				await dismissSessionSelectionKeyboard(ctx);
			});
		});

		this.bot.action(SCHEDULE_TARGET_NEW_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const pendingSchedule = this.pendingSchedule;
				if (!pendingSchedule || pendingSchedule.step !== "target") {
					await ctx.answerCbQuery("No pending schedule target selection.");
					return;
				}

				const callbackMessage = ctx.callbackQuery.message;
				const messageId = callbackMessage?.message_id;
				const chatId = callbackMessage?.chat.id;
				if (!messageId || chatId === undefined || messageId !== pendingSchedule.promptMessageId) {
					throw new Error("Could not continue the schedule flow.");
				}

				await this.dismissInlineKeyboard(chatId, pendingSchedule.promptMessageId);
				const promptMessage = await ctx.reply(
					formatScheduleWhenPromptText(getServerTimezone()),
					buildScheduleCancelKeyboard(),
				);
				this.pendingSchedule = {
					step: "when",
					promptMessageId: promptMessage.message_id,
					target: { type: "new_session" },
				};
				await ctx.answerCbQuery("Target selected.");
			});
		});

		this.bot.action(SCHEDULE_TARGET_CURRENT_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const pendingSchedule = this.pendingSchedule;
				if (!pendingSchedule || pendingSchedule.step !== "target") {
					await ctx.answerCbQuery("No pending schedule target selection.");
					return;
				}

				const callbackMessage = ctx.callbackQuery.message;
				const messageId = callbackMessage?.message_id;
				const chatId = callbackMessage?.chat.id;
				if (!messageId || chatId === undefined || messageId !== pendingSchedule.promptMessageId) {
					throw new Error("Could not continue the schedule flow.");
				}

				const currentSession = await this.coordinator.getCurrentSession();
				if (!currentSession) {
					throw new NoSelectedSessionError();
				}

				await this.dismissInlineKeyboard(chatId, pendingSchedule.promptMessageId);
				const promptMessage = await ctx.reply(
					formatScheduleWhenPromptText(getServerTimezone()),
					buildScheduleCancelKeyboard(),
				);
				this.pendingSchedule = {
					step: "when",
					promptMessageId: promptMessage.message_id,
					target: toExistingSessionScheduledTaskTarget(currentSession),
				};
				await ctx.answerCbQuery("Target selected.");
			});
		});

		this.bot.action(SCHEDULE_CONFIRM_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const pendingSchedule = this.pendingSchedule;
				if (!pendingSchedule || pendingSchedule.step !== "confirm") {
					await ctx.answerCbQuery("No pending schedule confirmation.");
					return;
				}

				const { refreshedSchedule, changed } = doesParsedScheduleRequireConfirmationRefresh(
					pendingSchedule.schedule,
					new Date(),
				);
				const existingConfirmationText = formatScheduleConfirmationText(pendingSchedule.schedule);
const refreshedConfirmationText = formatScheduleConfirmationText(refreshedSchedule);
const confirmationKeyboard = buildScheduleConfirmationKeyboard();
if (changed && refreshedConfirmationText !== existingConfirmationText) {
	this.pendingSchedule = {
		...pendingSchedule,
		schedule: refreshedSchedule,
	};
	await ctx.editMessageText(refreshedConfirmationText, confirmationKeyboard);
	await ctx.answerCbQuery("Schedule updated to the current confirmation time. Confirm again.");
	return;
}

				const callbackMessage = ctx.callbackQuery.message;
				const chatId = callbackMessage?.chat.id;
				if (chatId === undefined) {
					throw new Error("Could not continue the schedule flow.");
				}

				await this.dismissInlineKeyboard(chatId, pendingSchedule.promptMessageId);
				const promptMessage = await ctx.reply(formatSchedulePromptText(), buildScheduleCancelKeyboard());
				this.pendingSchedule = {
					...pendingSchedule,
					step: "prompt",
					promptMessageId: promptMessage.message_id,
					schedule: refreshedSchedule,
				};
				await ctx.answerCbQuery("Schedule confirmed.");
			});
		});

		this.bot.action(SCHEDULE_CANCEL_CALLBACK_DATA, async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				this.pendingSchedule = undefined;
				await dismissSessionSelectionKeyboard(ctx);
				await ctx.reply("Schedule canceled.");
			});
		});

		this.bot.action(new RegExp(`^${SESSION_SELECTION_CALLBACK_PREFIX}(.+)$`), async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const sessionId = ctx.match[1];
				if (!sessionId) {
					throw new SessionNotFoundError("missing-session-id");
				}

				const callbackMessage = ctx.callbackQuery.message;
				const chatId = callbackMessage?.chat.id;
				if (chatId === undefined) {
					throw new Error("Could not continue the session selection flow.");
				}

				const session = await this.coordinator.switchSessionById(sessionId);
				const persistedReply = await this.coordinator.getPersistedLastAssistantReply(session.path);
				await ctx.answerCbQuery("Session selected.");
				await ctx.reply(formatSelectionChangedText(session));
				if (!persistedReply) {
					await ctx.reply("No persisted assistant reply is available for this session yet.");
					return;
				}

				const client = createTelegramMessageClient(ctx.telegram);
				await sendStandaloneTelegramText(client, chatId, persistedReply, "markdown", this.config.telegramChunkSize);
			});
		});

		this.bot.action(new RegExp(`^${MODEL_SWITCH_CALLBACK_PREFIX}(\\d+):([a-f0-9]+)$`), async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const selection = await this.coordinator.getCurrentSessionModelSelection();
				if (!selection) {
					throw new NoSelectedSessionError();
				}

				const pageIndex = parseModelSelectionPageIndex(ctx.match[1]);
				const model = resolveModelSelection(selection.availableModels, ctx.match[2]);
				if (!model) {
					throw new SelectedModelUnavailableError();
				}

				const session = await this.coordinator.setCurrentSessionModel(model);
				const updatedSelection: CurrentSessionModelSelection = {
					currentModel: session.activeModel,
					availableModels: (await this.coordinator.getCurrentSessionModelSelection())?.availableModels ??
						selection.availableModels,
				};
				const popup = buildModelSelectionPopup(updatedSelection, pageIndex);
				if (popup.keyboard) {
					await ctx.editMessageText(popup.text, popup.keyboard);
				} else {
					await ctx.editMessageText(popup.text);
				}
				await ctx.answerCbQuery("Model selected.");
				await ctx.reply(formatModelSelectionChangedText(model));
			});
		});

		this.bot.on("text", async (ctx) => {
			const rawText = ctx.message.text;
			const text = rawText.trim();
			if (text.startsWith("/")) {
				return;
			}

			if (this.pendingSchedule) {
				await this.runWithErrorHandling(ctx, async () => {
					const pendingSchedule = this.pendingSchedule;
					if (!pendingSchedule) {
						return;
					}

					if (isCancelText(text)) {
						this.pendingSchedule = undefined;
						await this.dismissInlineKeyboard(ctx.chat.id, pendingSchedule.promptMessageId);
						await ctx.reply("Schedule canceled.");
						return;
					}

					if (pendingSchedule.step === "target") {
						await ctx.reply(formatScheduleTargetGuidanceText());
						return;
					}

					if (pendingSchedule.step === "when") { const parsed = await this.scheduleInputParser.parse(rawText, new Date(), getServerTimezone()); await this.dismissInlineKeyboard(ctx.chat.id, pendingSchedule.promptMessageId); const promptMessage = await ctx.reply( formatScheduleConfirmationText(parsed), buildScheduleConfirmationKeyboard(), ); this.pendingSchedule = { step: "confirm", promptMessageId: promptMessage.message_id, target: pendingSchedule.target, schedule: parsed, }; return; }

					if (pendingSchedule.step === "prompt") {
						const task = await this.scheduler.createTask({
							schedule: pendingSchedule.schedule,
							prompt: rawText,
							target: pendingSchedule.target,
						});
						this.pendingSchedule = undefined;
						await this.dismissInlineKeyboard(ctx.chat.id, pendingSchedule.promptMessageId);
						await ctx.reply(formatScheduledTaskCreatedText(task));
						return;
					}

					await ctx.reply(formatScheduleAwaitingConfirmationText());
				});
				return;
			}

			if (this.pendingRename) {
				await this.runWithErrorHandling(ctx, async () => {
					const pendingRename = this.pendingRename;
					const session = await this.coordinator.renameCurrentSession(rawText);
					this.pendingRename = undefined;
					if (pendingRename) {
						await this.dismissInlineKeyboard(ctx.chat.id, pendingRename.promptMessageId);
					}
					await ctx.reply(formatRenameConfirmationText(session.name ?? rawText.trim()));
				});
				return;
			}

			if (text.length === 0) {
				return;
			}

			await this.runWithErrorHandling(ctx, async () => {
				const streamer = new TelegramReplyStreamer(createTelegramMessageClient(ctx.telegram), ctx.chat.id, {
					throttleMs: this.config.streamThrottleMs,
					chunkSize: this.config.telegramChunkSize,
				});

				await streamer.start();
				try {
					const result = await this.coordinator.sendPrompt(text, {
						onProgress: (update) => {
							streamer.pushProgress(update.summary);
						},
						onAssistantText: (assistantText) => {
							streamer.pushText(assistantText);
						},
					});
					await streamer.finish(result.aborted ? "aborted" : "completed");
				} catch (error) {
					await streamer.finish("error", formatUserFacingError(error));
					return;
				}
			});
		});

		this.bot.catch(async (error, ctx) => {
			console.error("[pi-telegram-bot] Unhandled Telegram error:", error);
			if (ctx.chat?.type === "private") {
				await ctx.reply(formatUserFacingError(error));
			}
		});
	}

	private isAuthorizedPrivateMessage(ctx: BotContext): boolean {
		return ctx.chat?.type === "private" && ctx.from?.id === this.config.authorizedTelegramUserId;
	}

	private async dismissInlineKeyboard(chatId: number, messageId: number): Promise<void> {
		try {
			await this.bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, undefined);
		} catch {
			return;
		}
	}

	private async runWithErrorHandling(ctx: BotContext, operation: () => Promise<void>): Promise<void> {
		try {
	await operation();
} catch (error) {
	const userFacingError = formatUserFacingError(error);
	if (isCallbackContext(ctx)) {
		await ctx.answerCbQuery(formatCallbackQueryError(userFacingError));
	}
	await ctx.reply(userFacingError);
}
	}
}

export interface TelegramBotApp {
	pendingSchedule: PendingScheduleState | undefined;
}

function buildScheduleTargetKeyboard() {
	return Markup.inlineKeyboard([
		[Markup.button.callback("new session", SCHEDULE_TARGET_NEW_CALLBACK_DATA)],
		[Markup.button.callback("current session", SCHEDULE_TARGET_CURRENT_CALLBACK_DATA)],
		[Markup.button.callback("cancel", SCHEDULE_CANCEL_CALLBACK_DATA)],
	]);
}

function buildScheduleCancelKeyboard() {
	return Markup.inlineKeyboard([[Markup.button.callback("cancel", SCHEDULE_CANCEL_CALLBACK_DATA)]]);
}

function buildScheduleConfirmationKeyboard() {
	return Markup.inlineKeyboard([
		[Markup.button.callback("confirm", SCHEDULE_CONFIRM_CALLBACK_DATA)],
		[Markup.button.callback("cancel", SCHEDULE_CANCEL_CALLBACK_DATA)],
	]);
}

function isCancelText(text: string): boolean {
	return text.trim().toLowerCase() === "cancel";
}

function toExistingSessionScheduledTaskTarget(session: SessionCatalogEntry) {
	return {
		type: "existing_session" as const,
		sessionPath: session.path,
		sessionId: session.id,
		sessionName: session.name,
	};
}

function toScheduledTaskMenuAction(value: string | undefined): ScheduledTaskMenuAction {
	return value === "runscheduled" ? "runscheduled" : "unschedule";
}

function buildScheduledTaskSelectionKeyboard(tasks: ScheduledTask[], action: ScheduledTaskMenuAction, pageIndex = 0) {
	if (tasks.length === 0) {
		return undefined;
	}

	const pageCount = getScheduledTaskSelectionPageCount(tasks.length);
	const normalizedPageIndex = normalizeScheduledTaskSelectionPageIndex(pageIndex, tasks.length);
	const pageTasks = getScheduledTaskSelectionPageTasks(tasks, normalizedPageIndex);
	const rows = pageTasks.map((task) => [
		Markup.button.callback(
			buildScheduledTaskButtonLabel(task),
			`${getScheduledTaskSelectionCallbackPrefix(action)}${createScheduledTaskSelectionToken(task)}`,
		),
	]);
	const navigationRow = buildScheduledTaskSelectionNavigationRow(action, normalizedPageIndex, pageCount);
	if (navigationRow) {
		rows.push(navigationRow);
	}
	rows.push([Markup.button.callback("cancel", SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA)]);

	return Markup.inlineKeyboard(rows);
}

function buildScheduledTaskConfirmationKeyboard(action: ScheduledTaskMenuAction, task: ScheduledTask) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback(
				"confirm",
				`${getScheduledTaskConfirmationCallbackPrefix(action)}${createScheduledTaskSelectionToken(task)}`,
			),
		],
		[Markup.button.callback("cancel", SCHEDULED_TASK_SELECTION_CANCEL_CALLBACK_DATA)],
	]);
}

function buildScheduledTaskSelectionPopup(tasks: ScheduledTask[], action: ScheduledTaskMenuAction, pageIndex = 0): {
	text: string;
	keyboard: ReturnType<typeof buildScheduledTaskSelectionKeyboard> | undefined;
} {
	if (tasks.length === 0) {
		return {
			text: formatScheduledTaskSelectionText(tasks, { action }),
			keyboard: undefined,
		};
	}

	const normalizedPageIndex = normalizeScheduledTaskSelectionPageIndex(pageIndex, tasks.length);
	const pageTasks = getScheduledTaskSelectionPageTasks(tasks, normalizedPageIndex);
	return {
		text: formatScheduledTaskSelectionText(pageTasks, {
			action,
			pageIndex: normalizedPageIndex,
			pageCount: getScheduledTaskSelectionPageCount(tasks.length),
			pageStartIndex: normalizedPageIndex * SCHEDULED_TASK_SELECTION_PAGE_SIZE,
		}),
		keyboard: buildScheduledTaskSelectionKeyboard(tasks, action, normalizedPageIndex),
	};
}

function getScheduledTaskSelectionPageTasks(tasks: ScheduledTask[], pageIndex: number): ScheduledTask[] {
	const startIndex = pageIndex * SCHEDULED_TASK_SELECTION_PAGE_SIZE;
	return tasks.slice(startIndex, startIndex + SCHEDULED_TASK_SELECTION_PAGE_SIZE);
}

function getScheduledTaskSelectionPageCount(taskCount: number): number {
	return Math.max(1, Math.ceil(taskCount / SCHEDULED_TASK_SELECTION_PAGE_SIZE));
}

function normalizeScheduledTaskSelectionPageIndex(pageIndex: number, taskCount: number): number {
	if (!Number.isFinite(pageIndex) || pageIndex <= 0) {
		return 0;
	}

	return Math.min(Math.trunc(pageIndex), getScheduledTaskSelectionPageCount(taskCount) - 1);
}

function buildScheduledTaskSelectionNavigationRow(
	action: ScheduledTaskMenuAction,
	pageIndex: number,
	pageCount: number,
) {
	if (pageCount <= 1) {
		return undefined;
	}

	const buttons = [];
	if (pageIndex > 0) {
		buttons.push(
			Markup.button.callback(
				"Last page",
				`${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}${action}:${pageIndex - 1}`,
			),
		);
	}
	if (pageIndex < pageCount - 1) {
		buttons.push(
			Markup.button.callback(
				"Next page",
				`${SCHEDULED_TASK_SELECTION_PAGE_CALLBACK_PREFIX}${action}:${pageIndex + 1}`,
			),
		);
	}

	return buttons.length > 0 ? buttons : undefined;
}

function parseScheduledTaskSelectionPageIndex(value: string | undefined): number {
	if (!value) {
		return 0;
	}

	const pageIndex = Number.parseInt(value, 10);
	return Number.isNaN(pageIndex) ? 0 : pageIndex;
}

function buildScheduledTaskButtonLabel(task: ScheduledTask): string {
	return `${task.id} | ${task.prompt}`.slice(0, 60);
}

function getScheduledTaskSelectionCallbackPrefix(action: ScheduledTaskMenuAction): string {
	return action === "runscheduled"
		? SCHEDULED_TASK_RUN_SELECT_CALLBACK_PREFIX
		: SCHEDULED_TASK_UNSCHEDULE_SELECT_CALLBACK_PREFIX;
}

function getScheduledTaskConfirmationCallbackPrefix(action: ScheduledTaskMenuAction): string {
	return action === "runscheduled"
		? SCHEDULED_TASK_RUN_CONFIRM_CALLBACK_PREFIX
		: SCHEDULED_TASK_UNSCHEDULE_CONFIRM_CALLBACK_PREFIX;
}

function createScheduledTaskSelectionToken(task: ScheduledTask): string {
	return createHash("sha256").update(task.id).digest("hex").slice(0, 12);
}

function resolveScheduledTaskSelection(tasks: ScheduledTask[], selectionToken: string | undefined): ScheduledTask | undefined {
	if (!selectionToken) {
		return undefined;
	}

	return tasks.find((task) => createScheduledTaskSelectionToken(task) === selectionToken);
}

function requireScheduledTaskSelection(tasks: ScheduledTask[], selectionToken: string | undefined): ScheduledTask {
	const task = resolveScheduledTaskSelection(tasks, selectionToken);
	if (!task) {
		throw new Error("That scheduled task is no longer available. Reopen the command and try again.");
	}

	return task;
}

export function buildSessionKeyboard(sessions: SessionCatalogEntry[], pageIndex = 0) {
	const selectableSessions = getSelectableSessions(sessions);
	if (selectableSessions.length === 0) {
		return undefined;
	}

	const pageCount = getSessionSelectionPageCount(selectableSessions.length);
	const normalizedPageIndex = normalizeSessionSelectionPageIndex(pageIndex, selectableSessions.length);
	const pageSessions = getSessionSelectionPageSessions(selectableSessions, normalizedPageIndex);
	const rows = pageSessions.map((session) => [
		Markup.button.callback(buildSessionButtonLabel(session), `${SESSION_SELECTION_CALLBACK_PREFIX}${session.id}`),
	]);
	const navigationRow = buildSessionSelectionNavigationRow(normalizedPageIndex, pageCount);
	if (navigationRow) {
		rows.push(navigationRow);
	}
	rows.push([Markup.button.callback("Clear all sessions", SESSION_CLEAR_ALL_CALLBACK_DATA)]);
	rows.push([Markup.button.callback("cancel", SESSION_SELECTION_CANCEL_CALLBACK_DATA)]);

	return Markup.inlineKeyboard(rows);
}

function buildClearAllSessionsConfirmationKeyboard() {
	return Markup.inlineKeyboard([
		[Markup.button.callback("confirm clear all sessions", SESSION_CLEAR_ALL_CONFIRM_CALLBACK_DATA)],
		[Markup.button.callback("cancel", SESSION_SELECTION_CANCEL_CALLBACK_DATA)],
	]);
}

function buildClearAllSessionsConfirmationText(): string {
	return [
		"Clear all sessions for this workspace?",
		"This deletes all persisted Pi session files for the configured workspace only.",
		"Tap confirm to continue, or cancel.",
	].join("\n");
}

function buildRenameKeyboard() {
	return Markup.inlineKeyboard([[Markup.button.callback("cancel", RENAME_CANCEL_CALLBACK_DATA)]]);
}

export function buildModelKeyboard(selection: CurrentSessionModelSelection, pageIndex = 0) {
	if (selection.availableModels.length === 0) {
		return undefined;
	}

	const pageCount = getModelSelectionPageCount(selection.availableModels.length);
	const normalizedPageIndex = normalizeModelSelectionPageIndex(pageIndex, selection.availableModels.length);
	const pageModels = getModelSelectionPageModels(selection.availableModels, normalizedPageIndex);
	const rows = pageModels.map((model) => [
		Markup.button.callback(
			buildModelButtonLabel(model, selection.currentModel),
			`${MODEL_SWITCH_CALLBACK_PREFIX}${normalizedPageIndex}:${createModelSelectionToken(model)}`,
		),
	]);
	const navigationRow = buildModelSelectionNavigationRow(normalizedPageIndex, pageCount);
	if (navigationRow) {
		rows.push(navigationRow);
	}
	rows.push([Markup.button.callback("cancel", MODEL_SELECTION_CANCEL_CALLBACK_DATA)]);

	return Markup.inlineKeyboard(rows);
}

function buildSessionSelectionPopup(sessions: SessionCatalogEntry[], pageIndex = 0): {
	text: string;
	keyboard: ReturnType<typeof buildSessionKeyboard> | undefined;
} {
	const selectableSessions = getSelectableSessions(sessions);
	if (selectableSessions.length === 0) {
		return {
			text: formatSessionsText(sessions),
			keyboard: undefined,
		};
	}

	const normalizedPageIndex = normalizeSessionSelectionPageIndex(pageIndex, selectableSessions.length);
	const pageSessions = getSessionSelectionPageSessions(selectableSessions, normalizedPageIndex);
	return {
		text: formatSessionsText(pageSessions, {
			pageIndex: normalizedPageIndex,
			pageCount: getSessionSelectionPageCount(selectableSessions.length),
			pageStartIndex: normalizedPageIndex * SESSION_SELECTION_PAGE_SIZE,
		}),
		keyboard: buildSessionKeyboard(sessions, normalizedPageIndex),
	};
}

function buildModelSelectionPopup(selection: CurrentSessionModelSelection, pageIndex = 0): {
	text: string;
	keyboard: ReturnType<typeof buildModelKeyboard> | undefined;
} {
	if (selection.availableModels.length === 0) {
		return {
			text: formatNoAvailableModelsText(selection),
			keyboard: undefined,
		};
	}

	const normalizedPageIndex = normalizeModelSelectionPageIndex(pageIndex, selection.availableModels.length);
	return {
		text: formatModelSelectionText(selection, {
			pageIndex: normalizedPageIndex,
			pageCount: getModelSelectionPageCount(selection.availableModels.length),
		}),
		keyboard: buildModelKeyboard(selection, normalizedPageIndex),
	};
}

function getSelectableSessions(sessions: SessionCatalogEntry[]): SessionCatalogEntry[] {
	return sessions.filter((session) => session.source === "pi");
}

function getSessionSelectionPageSessions(
	sessions: SessionCatalogEntry[],
	pageIndex: number,
): SessionCatalogEntry[] {
	const startIndex = pageIndex * SESSION_SELECTION_PAGE_SIZE;
	return sessions.slice(startIndex, startIndex + SESSION_SELECTION_PAGE_SIZE);
}

function getSessionSelectionPageCount(sessionCount: number): number {
	return Math.max(1, Math.ceil(sessionCount / SESSION_SELECTION_PAGE_SIZE));
}

function normalizeSessionSelectionPageIndex(pageIndex: number, sessionCount: number): number {
	if (!Number.isFinite(pageIndex) || pageIndex <= 0) {
		return 0;
	}

	return Math.min(Math.trunc(pageIndex), getSessionSelectionPageCount(sessionCount) - 1);
}

function buildSessionSelectionNavigationRow(pageIndex: number, pageCount: number) {
	if (pageCount <= 1) {
		return undefined;
	}

	const buttons = [];
	if (pageIndex > 0) {
		buttons.push(
			Markup.button.callback("Last page", `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}${pageIndex - 1}`),
		);
	}
	if (pageIndex < pageCount - 1) {
		buttons.push(
			Markup.button.callback("Next page", `${SESSION_SELECTION_PAGE_CALLBACK_PREFIX}${pageIndex + 1}`),
		);
	}

	return buttons.length > 0 ? buttons : undefined;
}

function getModelSelectionPageModels(models: readonly PiModelDescriptor[], pageIndex: number): PiModelDescriptor[] {
	const startIndex = pageIndex * MODEL_SELECTION_PAGE_SIZE;
	return models.slice(startIndex, startIndex + MODEL_SELECTION_PAGE_SIZE);
}

function getModelSelectionPageCount(modelCount: number): number {
	return Math.max(1, Math.ceil(modelCount / MODEL_SELECTION_PAGE_SIZE));
}

function normalizeModelSelectionPageIndex(pageIndex: number, modelCount: number): number {
	if (!Number.isFinite(pageIndex) || pageIndex <= 0) {
		return 0;
	}

	return Math.min(Math.trunc(pageIndex), getModelSelectionPageCount(modelCount) - 1);
}

function buildModelSelectionNavigationRow(pageIndex: number, pageCount: number) {
	if (pageCount <= 1) {
		return undefined;
	}

	const buttons = [];
	if (pageIndex > 0) {
		buttons.push(Markup.button.callback("Last page", `${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}${pageIndex - 1}`));
	}
	if (pageIndex < pageCount - 1) {
		buttons.push(Markup.button.callback("Next page", `${MODEL_SELECTION_PAGE_CALLBACK_PREFIX}${pageIndex + 1}`));
	}

	return buttons.length > 0 ? buttons : undefined;
}

function parseSessionSelectionPageIndex(value: string | undefined): number {
	if (!value) {
		return 0;
	}

	const pageIndex = Number.parseInt(value, 10);
	return Number.isNaN(pageIndex) ? 0 : pageIndex;
}

function parseModelSelectionPageIndex(value: string | undefined): number {
	if (!value) {
		return 0;
	}

	const pageIndex = Number.parseInt(value, 10);
	return Number.isNaN(pageIndex) ? 0 : pageIndex;
}

type SessionSelectionCancelContext = Pick<BotContext, "answerCbQuery" | "editMessageReplyMarkup">;

export async function dismissSessionSelectionKeyboard(ctx: SessionSelectionCancelContext): Promise<void> {
	await ctx.editMessageReplyMarkup(undefined);
	await ctx.answerCbQuery();
}

function buildSessionButtonLabel(session: SessionCatalogEntry): string {
	const prefix = session.isSelected ? "current" : "select";
	const name = session.name ?? session.id.slice(0, 8);
	return `${prefix}: ${name}`.slice(0, 60);
}

function buildModelButtonLabel(model: PiModelDescriptor, currentModel: PiModelDescriptor | undefined): string {
	const label = formatModelIdentifier(model);
	if (isSameModel(model, currentModel)) {
		return `current: ${label}`.slice(0, 60);
	}

	return label.slice(0, 60);
}

function createModelSelectionToken(model: PiModelDescriptor): string {
	return createHash("sha256").update(formatModelIdentifier(model)).digest("hex").slice(0, 12);
}

function resolveModelSelection(
	models: readonly PiModelDescriptor[],
	selectionToken: string | undefined,
): PiModelDescriptor | undefined {
	if (!selectionToken) {
		return undefined;
	}

	return models.find((model) => createModelSelectionToken(model) === selectionToken);
}

function formatModelIdentifier(model: PiModelDescriptor): string {
	return `${model.provider}/${model.id}`;
}

function isSameModel(left: PiModelDescriptor, right: PiModelDescriptor | undefined): boolean {
	return right !== undefined && left.provider === right.provider && left.id === right.id;
}

function isCallbackContext(ctx: BotContext): boolean {
	return "callback_query" in ctx.update;
}

export function shouldRejectUnauthorizedPrivateUpdate(update: Update, authorizedTelegramUserId: number): boolean {
	const privateInteractionUserId = getPrivateInteractionUserId(update);
	return privateInteractionUserId !== undefined && privateInteractionUserId !== authorizedTelegramUserId;
}

function getPrivateInteractionUserId(update: Update): number | undefined {
	if ("message" in update) {
		return getPrivateInteractiveMessageSenderId(update.message);
	}

	if ("edited_message" in update) {
		return getPrivateInteractiveMessageSenderId(update.edited_message);
	}

	if ("callback_query" in update) {
		return getPrivateCallbackQuerySenderId(update.callback_query);
	}

	return undefined;
}

function getPrivateInteractiveMessageSenderId(message: InteractiveMessage): number | undefined {
	if (message.chat.type !== "private" || message.from.is_bot || !hasInteractiveMessageContent(message)) {
		return undefined;
	}

	return message.from.id;
}

function hasInteractiveMessageContent(message: InteractiveMessage): boolean {
	for (const key of INTERACTIVE_MESSAGE_KEYS) {
		if (key in message) {
			return true;
		}
	}

	return false;
}

function getPrivateCallbackQuerySenderId(callbackQuery: CallbackQueryUpdate["callback_query"]): number | undefined {
	if (callbackQuery.from.is_bot || !callbackQuery.message || callbackQuery.message.chat.type !== "private") {
		return undefined;
	}

	return callbackQuery.from.id;
}

const CALLBACK_QUERY_ERROR_TEXT_LIMIT = 160;

function formatCallbackQueryError(userFacingError: string): string {
	return userFacingError.length <= CALLBACK_QUERY_ERROR_TEXT_LIMIT
		? userFacingError
		: "Request failed. See chat for details.";
}

function formatUserFacingError(error: unknown): string {
	if (
		error instanceof BusySessionError ||
		error instanceof InvalidSessionNameError ||
		error instanceof ModelNotAvailableError ||
		error instanceof NoSelectedSessionError ||
		error instanceof SelectedModelUnavailableError ||
		error instanceof SessionNotFoundError
	) {
		return error.message;
	}

	return error instanceof Error ? `Request failed: ${error.message}` : `Request failed: ${String(error)}`;
}
