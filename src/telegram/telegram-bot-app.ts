import { Markup, Telegraf, type Context } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../config/app-config.js";
import { AmbiguousSessionReferenceError, BusySessionError, SessionNotFoundError } from "../session/session-errors.js";
import { type SessionCatalogEntry, SessionCoordinator } from "../session/session-coordinator.js";
import {
	formatCurrentSessionText,
	formatHelpText,
	formatNewSessionText,
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

export class TelegramBotApp {
	private readonly bot: Telegraf<BotContext>;
	private readonly sessionPinSync: SessionPinSync;
	private removeActiveSessionObserver: (() => void) | undefined;
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
				const keyboard = buildSessionKeyboard(sessions);
				if (keyboard) {
					await ctx.reply(formatSessionsText(sessions), keyboard);
					return;
				}
				await ctx.reply(formatSessionsText(sessions));
			});
		});

		this.bot.command("current", async (ctx) => {
			await ctx.reply(formatCurrentSessionText(await this.coordinator.getCurrentSession()));
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

		this.bot.action(/^switch:(.+)$/, async (ctx) => {
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

		this.bot.on("text", async (ctx) => {
			const text = ctx.message.text.trim();
			if (text.length === 0 || text.startsWith("/")) {
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

function buildSessionKeyboard(sessions: SessionCatalogEntry[]) {
	const switchableSessions = sessions.filter((session) => session.source === "pi");
	if (switchableSessions.length === 0) {
		return undefined;
	}

	return Markup.inlineKeyboard(
		switchableSessions.map((session) => [
			Markup.button.callback(buildSessionButtonLabel(session), `switch:${session.id}`),
		]),
	);
}

function buildSessionButtonLabel(session: SessionCatalogEntry): string {
	const prefix = session.isSelected ? "current" : "switch";
	const name = session.name ?? session.id.slice(0, 8);
	return `${prefix}: ${name}`.slice(0, 60);
}

function isCallbackContext(ctx: BotContext): boolean {
	return "callbackQuery" in ctx.update;
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
		error instanceof SessionNotFoundError ||
		error instanceof AmbiguousSessionReferenceError
	) {
		return error.message;
	}

	return error instanceof Error ? `Request failed: ${error.message}` : `Request failed: ${String(error)}`;
}
