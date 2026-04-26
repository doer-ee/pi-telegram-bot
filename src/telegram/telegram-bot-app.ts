import { createHash } from "node:crypto";
import { Markup, Telegraf, type Context } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../config/app-config.js";
import { ModelNotAvailableError } from "../pi/pi-errors.js";
import type { CurrentSessionModelSelection, PiModelDescriptor } from "../pi/pi-types.js";
import {
	AmbiguousSessionReferenceError,
	BusySessionError,
	InvalidSessionNameError,
	NoSelectedSessionError,
	SelectedModelUnavailableError,
	SessionNotFoundError,
} from "../session/session-errors.js";
import { type SessionCatalogEntry, SessionCoordinator } from "../session/session-coordinator.js";
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
	formatSelectionChangedText,
	formatSessionsText,
	formatStartText,
	formatStatusText,
} from "./telegram-formatters.js";
import { registerTelegramBotCommands } from "./telegram-command-definitions.js";
import { createTelegramMessageClient } from "./telegram-message-client.js";
import { TelegramReplyStreamer } from "./telegram-reply-streamer.js";
import { SessionPinSync } from "./session-pin-sync.js";
import { parseSwitchCommandTarget } from "./switch-command.js";

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

export const SESSION_SWITCH_CALLBACK_PREFIX = "switch:";
export const SESSION_SELECTION_PAGE_CALLBACK_PREFIX = "sessions:page:";
export const SESSION_SELECTION_CANCEL_CALLBACK_DATA = "sessions:cancel";
const SESSION_SELECTION_PAGE_SIZE = 5;
export const MODEL_SELECTION_PAGE_CALLBACK_PREFIX = "models:page:";
export const MODEL_SELECTION_CANCEL_CALLBACK_DATA = "models:cancel";
export const MODEL_SWITCH_CALLBACK_PREFIX = "models:select:";
const MODEL_SELECTION_PAGE_SIZE = 5;
export const RENAME_CANCEL_CALLBACK_DATA = "rename:cancel";

interface PendingRenameState {
	promptMessageId: number;
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

		this.bot.command("switch", async (ctx) => {
			const target = parseSwitchCommandTarget(ctx.message.text);
			if (!target) {
				await ctx.reply("Usage: /switch <session-id-prefix-or-id>");
				return;
			}

			await this.runWithErrorHandling(ctx, async () => {
				const session = await this.coordinator.switchSessionByReference(target);
				await ctx.reply(formatSelectionChangedText(session));
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

		this.bot.action(new RegExp(`^${SESSION_SWITCH_CALLBACK_PREFIX}(.+)$`), async (ctx) => {
			await this.runWithErrorHandling(ctx, async () => {
				const sessionId = ctx.match[1];
				if (!sessionId) {
					throw new SessionNotFoundError("missing-session-id");
				}
				const session = await this.coordinator.switchSessionById(sessionId);
				await ctx.answerCbQuery("Session selected.");
				await ctx.reply(formatSelectionChangedText(session));
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

			if (this.pendingRename) {
				await this.runWithErrorHandling(ctx, async () => {
					const pendingRename = this.pendingRename;
					const session = await this.coordinator.renameCurrentSession(rawText);
					this.pendingRename = undefined;
					if (pendingRename) {
						await this.dismissPendingRenameKeyboard(ctx.chat.id, pendingRename.promptMessageId);
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

	private async dismissPendingRenameKeyboard(chatId: number, messageId: number): Promise<void> {
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
			if (isCallbackContext(ctx)) {
				await ctx.answerCbQuery(formatUserFacingError(error));
			}
			await ctx.reply(formatUserFacingError(error));
		}
	}
}

export function buildSessionKeyboard(sessions: SessionCatalogEntry[], pageIndex = 0) {
	const switchableSessions = getSwitchableSessions(sessions);
	if (switchableSessions.length === 0) {
		return undefined;
	}

	const pageCount = getSessionSelectionPageCount(switchableSessions.length);
	const normalizedPageIndex = normalizeSessionSelectionPageIndex(pageIndex, switchableSessions.length);
	const pageSessions = getSessionSelectionPageSessions(switchableSessions, normalizedPageIndex);
	const rows = pageSessions.map((session) => [
		Markup.button.callback(buildSessionButtonLabel(session), `${SESSION_SWITCH_CALLBACK_PREFIX}${session.id}`),
	]);
	const navigationRow = buildSessionSelectionNavigationRow(normalizedPageIndex, pageCount);
	if (navigationRow) {
		rows.push(navigationRow);
	}
	rows.push([Markup.button.callback("cancel", SESSION_SELECTION_CANCEL_CALLBACK_DATA)]);

	return Markup.inlineKeyboard(rows);
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
	const switchableSessions = getSwitchableSessions(sessions);
	if (switchableSessions.length === 0) {
		return {
			text: formatSessionsText(sessions),
			keyboard: undefined,
		};
	}

	const normalizedPageIndex = normalizeSessionSelectionPageIndex(pageIndex, switchableSessions.length);
	const pageSessions = getSessionSelectionPageSessions(switchableSessions, normalizedPageIndex);
	return {
		text: formatSessionsText(pageSessions, {
			pageIndex: normalizedPageIndex,
			pageCount: getSessionSelectionPageCount(switchableSessions.length),
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

function getSwitchableSessions(sessions: SessionCatalogEntry[]): SessionCatalogEntry[] {
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
	const prefix = session.isSelected ? "current" : "switch";
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

function formatUserFacingError(error: unknown): string {
	if (
		error instanceof BusySessionError ||
		error instanceof InvalidSessionNameError ||
		error instanceof ModelNotAvailableError ||
		error instanceof NoSelectedSessionError ||
		error instanceof SelectedModelUnavailableError ||
		error instanceof SessionNotFoundError ||
		error instanceof AmbiguousSessionReferenceError
	) {
		return error.message;
	}

	return error instanceof Error ? `Request failed: ${error.message}` : `Request failed: ${String(error)}`;
}
