import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type {
	PiModelDescriptor,
	PiPromptContent,
	PiRuntimeFactory,
	PiRuntimePort,
	PiSessionEvent,
	PiSessionEventListener,
	PiSessionPort,
	SessionInfoRecord,
	SessionTitleRefinementRequest,
} from "../src/pi/pi-types.js";
import { SessionCoordinator } from "../src/session/session-coordinator.js";
import {
	createEmptyAppState,
	type AppStateStore,
	type StoredBotOwnedSessionPin,
	type StoredSelectedSession,
} from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import { TelegramBotApp } from "../src/telegram/telegram-bot-app.js";
import { DEFAULT_TELEGRAM_MEDIA_PROMPT } from "../src/telegram/telegram-media-prompt.js";
import { SpeechToTextError, SpeechToTextNotConfiguredError } from "../src/telegram/telegram-speech-to-text.js";

const AUTHORIZED_USER_ID = 101;
const CHAT_ID = 101;
const BOT_ID = 999;
const BOT_USERNAME = "pi_test_bot";
const PROGRESS_MESSAGE_ID = 700;

let restoreTelegramApi: (() => void) | undefined;

afterEach(() => {
	restoreTelegramApi?.();
	restoreTelegramApi = undefined;
});

describe("TelegramBotApp prompt progress behavior", () => {
	it("uses real runtime progress events to keep progress visible and send the final answer separately", async () => {
		const apiCalls: TelegramApiCall[] = [];
		const secretToken = "sk-proj-AbCdEf1234567890XYZ987654321";
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		runtimeFactory.getSession(session.path)?.queuePromptEvents([
			{
				type: "tool_execution_start",
				toolName: "grep",
				args: {
					include: `src/**/*OPENAI_API_KEY=${secretToken}*.ts`,
					pattern: `Authorization: Bearer ${secretToken}`,
				},
			},
			{
				type: "tool_call",
				toolName: "skill",
				input: {
					name: "listing-agent-research",
					location: "/Users/jacobhere/.config/opencode/skills/listing-agent-research/SKILL.md",
				},
			},
			{
				type: "tool_execution_start",
				toolName: "read",
				args: {
					path: "/workspace/src/session/session-coordinator.ts",
				},
			},
			{
				type: "tool_execution_start",
				toolName: "bash",
				args: {
					command: `OPENAI_API_KEY=${secretToken} npm test -- --runInBand`,
				},
			},
		]);

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createPromptUpdate("Please help with the progress UI"));
		await waitUntil(() => apiCalls.length === 3);

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Thinking...",
					disable_notification: true,
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID,
					inline_message_id: undefined,
					text: "Completed.\n• Searching files\n• Using skill: listing-agent-research\n• Reading .../src/session/session-coordinator.ts\n• Running command: OPENAI_API_KEY=[secret] npm test -- --runInBand",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "reply:Please help with the progress UI",
					parse_mode: "MarkdownV2",
				},
			},
		]);

		const combinedApiPayloads = JSON.stringify(apiCalls);
		expect(combinedApiPayloads).not.toContain(secretToken);
		expect(combinedApiPayloads).not.toContain("Authorization:");

		await app.stop();
	});

	it("returns from the Telegram text handler before a paused prompt finishes and still delivers completion later", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.queuePromptEvents([
			{
				type: "tool_execution_start",
				toolName: "read",
				args: {
					path: "/workspace/src/session/session-coordinator.ts",
				},
			},
		]);
		runtimeSession?.pauseNextPrompt();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		let handlerFinished = false;
		const handleUpdatePromise = bot.handleUpdate(createPromptUpdate("Please keep going")).then(() => {
			handlerFinished = true;
		});

		await waitUntil(() => hasProgressText(apiCalls, "Thinking...\n• Reading .../src/session/session-coordinator.ts"));

		expect(handlerFinished).toBe(true);
		expect(runtimeSession?.isStreaming).toBe(true);
		expect(apiCalls).toContainEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Thinking...",
				disable_notification: true,
			},
		});
		expect(apiCalls).toContainEqual({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: PROGRESS_MESSAGE_ID,
				inline_message_id: undefined,
				text: "Thinking...\n• Reading .../src/session/session-coordinator.ts",
			},
		});
		expect(hasProgressText(apiCalls, "Completed.\n• Reading .../src/session/session-coordinator.ts")).toBe(false);
		expect(hasSentText(apiCalls, "reply:Please keep going")).toBe(false);

		runtimeSession?.resumePausedPrompt();
		await handleUpdatePromise;
		await waitUntil(() => hasProgressText(apiCalls, "Completed.\n• Reading .../src/session/session-coordinator.ts"));
		await waitUntil(() => hasSentText(apiCalls, "reply:Please keep going"));

		expect(apiCalls).toContainEqual({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: PROGRESS_MESSAGE_ID,
				inline_message_id: undefined,
				text: "Completed.\n• Reading .../src/session/session-coordinator.ts",
			},
		});
		expect(apiCalls).toContainEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "reply:Please keep going",
				parse_mode: "MarkdownV2",
			},
		});

		await app.stop();
	});

	it("keeps freeform busy semantics truthful while a detached prompt is still active", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.pauseNextPrompt();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		let firstHandlerFinished = false;
		void bot.handleUpdate(createPromptUpdate("First prompt")).then(() => {
			firstHandlerFinished = true;
		});

		await waitUntil(() => hasSentText(apiCalls, "Thinking..."));
		apiCalls.length = 0;

		expect(firstHandlerFinished).toBe(true);
		expect(runtimeSession?.isStreaming).toBe(true);

		await bot.handleUpdate(createPromptUpdate("Second prompt", 2));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "A Pi run is already active. Abort it before sending another prompt or changing sessions or models.",
				},
			},
		]);

		await app.stop();
	});

	it("uses the caption as the direct-to-model instruction for authorized private photos", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (message) => ({
				content: [
					{ type: "text", text: message.caption ?? DEFAULT_TELEGRAM_MEDIA_PROMPT },
					{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
				],
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createPhotoUpdate("describe the wiring in this image"));
		await waitUntil(() => hasSentText(apiCalls, "reply:describe the wiring in this image"));

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			[
				{ type: "text", text: "describe the wiring in this image" },
				{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
			],
		]);

		await app.stop();
	});

	it("uses the exact default instruction for captionless private photos", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (message) => ({
				content: [
					{ type: "text", text: message.caption?.trim() || DEFAULT_TELEGRAM_MEDIA_PROMPT },
					{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
				],
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createPhotoUpdate(undefined));
		await waitUntil(() => hasSentText(apiCalls, `reply:${DEFAULT_TELEGRAM_MEDIA_PROMPT}`));

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			[
				{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
				{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
			],
		]);

		await app.stop();
	});

	it("shows speech-to-text progress and the transcript before the normal Pi run flow for private voice notes", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (_message, _config, _telegram, runtimeOptions) => {
				await runtimeOptions?.onSpeechToTextProgressStage?.("transcribing");
				await runtimeOptions?.onSpeechToTextProgressStage?.("got_result");
				return {
					content: "Please summarize this standup update",
					userPromptText: "Please summarize this standup update",
				};
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createVoiceUpdate());
		await waitUntil(() => hasSentText(apiCalls, "reply:Please summarize this standup update"));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Speech to text...\n• Got audio",
					disable_notification: true,
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID,
					inline_message_id: undefined,
					text: "Speech to text...\n• Got audio\n• Transcribing",
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID,
					inline_message_id: undefined,
					text: "Speech to text...\n• Got audio\n• Transcribing\n• Got result",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Transcript:\nPlease summarize this standup update",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Thinking...",
					disable_notification: true,
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID + 2,
					inline_message_id: undefined,
					text: "Completed.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "reply:Please summarize this standup update",
					parse_mode: "MarkdownV2",
				},
			},
		]);

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			"Please summarize this standup update",
		]);

		await app.stop();
	});

	it("routes private audio uploads through the detached prompt flow with the speech-to-text transcript", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (_message, _config, _telegram, runtimeOptions) => {
				await runtimeOptions?.onSpeechToTextProgressStage?.("transcribing");
				await runtimeOptions?.onSpeechToTextProgressStage?.("got_result");
				return {
					content: "Extract the action items from this audio file",
					userPromptText: "Extract the action items from this audio file",
				};
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createAudioUpdate());
		await waitUntil(() => hasSentText(apiCalls, "reply:Extract the action items from this audio file"));

		expect(hasProgressText(apiCalls, "Speech to text...\n• Got audio\n• Transcribing\n• Got result")).toBe(true);
		expect(hasSentText(apiCalls, "Transcript:\nExtract the action items from this audio file")).toBe(true);
		expect(findApiCallIndex(apiCalls, "sendMessage", "Transcript:\nExtract the action items from this audio file")).toBeLessThan(
			findApiCallIndex(apiCalls, "sendMessage", "Thinking..."),
		);

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			"Extract the action items from this audio file",
		]);

		await app.stop();
	});

	it("rejects a second prompt while a first voice message is still in the STT phase", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const sttPhaseGate = createDeferred<void>();
		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		let mediaResolverCalls = 0;
		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (message, _config, _telegram, runtimeOptions) => {
				mediaResolverCalls += 1;
				if (message.voice) {
					await runtimeOptions?.onSpeechToTextProgressStage?.("transcribing");
					await sttPhaseGate.promise;
					await runtimeOptions?.onSpeechToTextProgressStage?.("got_result");
					return {
						content: "Summarize this blocked voice note",
						userPromptText: "Summarize this blocked voice note",
					};
				}

				return {
					content: [
						{ type: "text", text: message.caption ?? DEFAULT_TELEGRAM_MEDIA_PROMPT },
						{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
					],
				};
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		const firstHandleUpdatePromise = bot.handleUpdate(createVoiceUpdate());
		await waitUntil(() => hasProgressText(apiCalls, "Speech to text...\n• Got audio\n• Transcribing"));

		apiCalls.length = 0;
		await bot.handleUpdate(createPromptUpdate("Second prompt while STT is busy", 2));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "A Pi run is already active. Abort it before sending another prompt or changing sessions or models.",
				},
			},
		]);
		expect(mediaResolverCalls).toBe(1);
		expect(coordinator.isBusy()).toBe(true);

		sttPhaseGate.resolve();
		await firstHandleUpdatePromise;
		await waitUntil(() => hasSentText(apiCalls, "reply:Summarize this blocked voice note"));

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			"Summarize this blocked voice note",
		]);

		await app.stop();
	});

	it("returns the exact speech-to-text guidance when private audio arrives without configured speech-to-text", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async () => {
				throw new SpeechToTextNotConfiguredError();
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createAudioUpdate());

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Speech to text...\n• Got audio",
					disable_notification: true,
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Speech to text is not configured. Please configure it first.",
				},
			},
		]);

		await app.stop();
	});

	it("does not show a fake speech-to-text result state when audio transcription fails", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (_message, _config, _telegram, runtimeOptions) => {
				await runtimeOptions?.onSpeechToTextProgressStage?.("transcribing");
				throw new SpeechToTextError("Speech to text request failed: upstream unavailable");
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createAudioUpdate());

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Speech to text...\n• Got audio",
					disable_notification: true,
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID,
					inline_message_id: undefined,
					text: "Speech to text...\n• Got audio\n• Transcribing",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Speech to text request failed: upstream unavailable",
				},
			},
		]);
		expect(hasProgressText(apiCalls, "Speech to text...\n• Got audio\n• Transcribing\n• Got result")).toBe(false);
		expect(hasSentText(apiCalls, "Transcript:\nExtract the action items from this audio file")).toBe(false);
		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([]);

		await app.stop();
	});

	it("routes supported image documents through the same direct-to-model prompt path", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (message) => ({
				content: [
					{ type: "text", text: message.caption?.trim() || DEFAULT_TELEGRAM_MEDIA_PROMPT },
					{ type: "image", data: "ZmFrZS1kb2N1bWVudC1pbWFnZQ==", mimeType: "image/png" },
				],
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createDocumentUpdate({ fileName: "diagram.png", mimeType: "image/png", caption: "inspect this diagram" }));
		await waitUntil(() => hasSentText(apiCalls, "reply:inspect this diagram"));

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([
			[
				{ type: "text", text: "inspect this diagram" },
				{ type: "image", data: "ZmFrZS1kb2N1bWVudC1pbWFnZQ==", mimeType: "image/png" },
			],
		]);

		await app.stop();
	});

	it("routes supported plain-text documents through a truthful local-read prompt path", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const routedPrompt = [
			"summarize these notes",
			"",
			"The user sent a Telegram plain-text document that was saved locally at:",
			join(tmpdir(), "telegram-upload-123", "notes.txt"),
			"",
			"This document was not attached directly to the model.",
			"Use the normal file-read path on that saved file, then answer the user's request.",
			"If you cannot read the file, say so explicitly.",
		].join("\n");

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async () => ({
				content: routedPrompt,
				userPromptText: "summarize these notes",
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createDocumentUpdate({ fileName: "notes.txt", mimeType: "text/plain", caption: "summarize these notes" }));
		await waitUntil(() => (runtimeFactory.getSession(session.path)?.promptPayloads.length ?? 0) === 1);

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([routedPrompt]);

		await app.stop();
	});

	it("routes supported PDFs through a truthful pi-docparser prompt path", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const routedPrompt = [
			"review this brief",
			"",
			"The user sent a Telegram document that was saved locally at:",
			join(tmpdir(), "telegram-upload-123", "brief.pdf"),
			"",
			"This document was not attached directly to the model.",
			"Use the installed document_parse tool from pi-docparser before answering.",
			"pi-docparser package source: npm:pi-docparser",
			"document_parse tool entry: /Users/example/.nvm/versions/node/v24.11.1/lib/node_modules/pi-docparser/extensions/docparser/index.ts",
			"Do not use look_at for this document.",
			"If document_parse cannot run or the document format is unsupported, stop and say that explicitly.",
		].join("\n");

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async () => ({
				content: routedPrompt,
				userPromptText: "review this brief",
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createDocumentUpdate({ fileName: "brief.pdf", mimeType: "application/pdf", caption: "review this brief" }));
		await waitUntil(() => (runtimeFactory.getSession(session.path)?.promptPayloads.length ?? 0) === 1);

		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([routedPrompt]);

		await app.stop();
	});

	it("fails explicitly when parser-backed PDF processing is unavailable", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async () => {
				throw new Error("pi-docparser is unavailable in the bot environment (npm:pi-docparser is not configured in the current Pi package settings. Run pi install npm:pi-docparser first.), so brief.pdf was not sent to Pi.");
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		await bot.handleUpdate(createDocumentUpdate({ fileName: "brief.pdf", mimeType: "application/pdf" }));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Request failed: pi-docparser is unavailable in the bot environment (npm:pi-docparser is not configured in the current Pi package settings. Run pi install npm:pi-docparser first.), so brief.pdf was not sent to Pi.",
				},
			},
		]);
		expect(runtimeFactory.getSession(session.path)?.promptPayloads).toEqual([]);

		await app.stop();
	});

	it("extends truthful busy handling to media prompts", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.pauseNextPrompt();

		let mediaResolverCalls = 0;
		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async (message) => {
				mediaResolverCalls += 1;
				return {
					content: [
						{ type: "text", text: message.caption ?? DEFAULT_TELEGRAM_MEDIA_PROMPT },
						{ type: "image", data: "ZmFrZS1waG90bw==", mimeType: "image/jpeg" },
					],
				};
			},
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		void bot.handleUpdate(createPromptUpdate("First prompt"));
		await waitUntil(() => hasSentText(apiCalls, "Thinking..."));
		apiCalls.length = 0;

		await bot.handleUpdate(createPhotoUpdate("second photo prompt", 2));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "A Pi run is already active. Abort it before sending another prompt or changing sessions or models.",
				},
			},
		]);
		expect(mediaResolverCalls).toBe(0);

		await app.stop();
	});

	it("does not clean up a saved system-temp upload when streamer startup fails before the Pi prompt settles", async () => {
		const apiCalls: TelegramApiCall[] = [];
		let failedThinkingStart = false;
		restoreTelegramApi = interceptTelegramApi(apiCalls, {
			beforeResolve: async (method, payload) => {
				if (!failedThinkingStart && method === "sendMessage" && getPayloadText(payload) === "Thinking...") {
					failedThinkingStart = true;
					throw new Error("Telegram could not start the progress stream.");
				}
			},
		});

		const tempRoot = await mkdtemp(join(tmpdir(), "pi-telegram-bot-upload-cleanup-"));
		const uploadDirectory = join(tempRoot, "telegram-upload-123");
		const uploadPath = join(uploadDirectory, "notes.txt");
		await mkdir(uploadDirectory, { recursive: true });
		await writeFile(uploadPath, "temporary upload contents");

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.pauseNextPrompt();

		let cleanupCalls = 0;
		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync(), undefined, undefined, {
			mediaPromptResolver: async () => ({
				content: [
					"summarize these notes",
					"",
					"The user sent a Telegram plain-text document that was saved locally at:",
					uploadPath,
				].join("\n"),
				userPromptText: "summarize these notes",
				cleanup: async () => {
					await rm(uploadDirectory, { recursive: true, force: true });
					cleanupCalls += 1;
				},
			}),
		});
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		const handleUpdatePromise = bot.handleUpdate(
			createDocumentUpdate({ fileName: "notes.txt", mimeType: "text/plain", caption: "summarize these notes" }),
		);

		await handleUpdatePromise;
		await waitUntil(() => hasSentText(apiCalls, "Request failed: Telegram could not start the progress stream."));

		expect(runtimeSession?.isStreaming).toBe(true);
		expect(cleanupCalls).toBe(0);
		expect(await pathExists(uploadPath)).toBe(true);

		runtimeSession?.resumePausedPrompt();
		await waitUntil(() => cleanupCalls === 1);

		expect(runtimeSession?.isStreaming).toBe(false);
		expect(await pathExists(uploadDirectory)).toBe(false);

		await app.stop();
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("keeps /abort wired to the active detached prompt run", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		runtimeFactory.getSession(session.path)?.pauseNextPrompt();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		let handlerFinished = false;
		void bot.handleUpdate(createPromptUpdate("Prompt to abort")).then(() => {
			handlerFinished = true;
		});

		await waitUntil(() => hasSentText(apiCalls, "Thinking..."));

		expect(handlerFinished).toBe(true);

		await bot.handleUpdate(createCommandUpdate("/abort", 2));
		await waitUntil(() => hasSentText(apiCalls, "Abort requested."));
		await waitUntil(() => hasProgressText(apiCalls, "Run aborted."));
		await waitUntil(() => countSentTexts(apiCalls, "Run aborted.") >= 1);

		expect(apiCalls).toContainEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Abort requested.",
			},
		});
		expect(apiCalls).toContainEqual({
			method: "editMessageText",
			payload: {
				chat_id: CHAT_ID,
				message_id: PROGRESS_MESSAGE_ID,
				inline_message_id: undefined,
				text: "Run aborted.",
			},
		});
		expect(apiCalls).toContainEqual({
			method: "sendMessage",
			payload: {
				chat_id: CHAT_ID,
				text: "Run aborted.",
			},
		});
		expect((await coordinator.getStatus()).busy).toBe(false);

		await app.stop();
	});

	it("delivers detached prompt failure after handler return through detached Telegram delivery", async () => {
		const apiCalls: TelegramApiCall[] = [];
		restoreTelegramApi = interceptTelegramApi(apiCalls);

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.pauseNextPrompt();
		runtimeSession?.failNextPrompt(new Error("Pi bridge exploded."));

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		let handlerFinished = false;
		const handleUpdatePromise = bot.handleUpdate(createPromptUpdate("Please fail later")).then(() => {
			handlerFinished = true;
		});

		await waitUntil(() => hasSentText(apiCalls, "Thinking..."));

		expect(handlerFinished).toBe(true);
		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Thinking...",
					disable_notification: true,
				},
			},
		]);

		runtimeSession?.resumePausedPrompt();
		await handleUpdatePromise;
		await waitUntil(() => hasProgressText(apiCalls, "Request failed."));
		await waitUntil(() => hasSentText(apiCalls, "Request failed: Pi bridge exploded."));

		expect(apiCalls).toEqual([
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Thinking...",
					disable_notification: true,
				},
			},
			{
				method: "editMessageText",
				payload: {
					chat_id: CHAT_ID,
					message_id: PROGRESS_MESSAGE_ID,
					inline_message_id: undefined,
					text: "Request failed.",
				},
			},
			{
				method: "sendMessage",
				payload: {
					chat_id: CHAT_ID,
					text: "Request failed: Pi bridge exploded.",
				},
			},
		]);

		await app.stop();
	});

	it("app.stop aborts an in-flight detached prompt and waits for cleanup before resolving", async () => {
		const apiCalls: TelegramApiCall[] = [];
		const releaseFinalAbortDelivery = createDeferred<void>();
		restoreTelegramApi = interceptTelegramApi(apiCalls, {
			beforeResolve: async (method, payload) => {
				if (method === "sendMessage" && getPayloadText(payload) === "Run aborted.") {
					await releaseFinalAbortDelivery.promise;
				}
			},
		});

		const runtimeFactory = new MockPiRuntimeFactory();
		const coordinator = new SessionCoordinator("/workspace", createAppStateStoreStub(), runtimeFactory);
		await coordinator.initialize();
		const session = await coordinator.createNewSession();
		const runtimeSession = runtimeFactory.getSession(session.path);
		runtimeSession?.pauseNextPrompt();

		const app = new TelegramBotApp(createAppConfig(), coordinator, createSessionPinSync());
		const bot = Reflect.get(app, "bot") as InternalTelegrafBot;
		Reflect.set(bot, "botInfo", createBotInfo());

		let handlerFinished = false;
		void bot.handleUpdate(createPromptUpdate("Stop me cleanly")).then(() => {
			handlerFinished = true;
		});

		await waitUntil(() => hasSentText(apiCalls, "Thinking..."));

		expect(handlerFinished).toBe(true);
		expect(runtimeSession?.isStreaming).toBe(true);

		let stopResolved = false;
		const stopPromise = app.stop().then(() => {
			stopResolved = true;
		});

		await waitUntil(() => hasProgressText(apiCalls, "Run aborted."));
		await waitUntil(() => hasSentText(apiCalls, "Run aborted."));
		await flushAsyncWork();

		expect(stopResolved).toBe(false);
		expect(coordinator.isBusy()).toBe(false);
		expect(runtimeSession?.isStreaming).toBe(false);

		releaseFinalAbortDelivery.resolve();
		await stopPromise;

		expect(stopResolved).toBe(true);
		expect(coordinator.isBusy()).toBe(false);
		expect(runtimeSession?.isStreaming).toBe(false);
		expect((Reflect.get(app, "inFlightPromptRuns") as Set<Promise<void>>).size).toBe(0);
	});
});

function interceptTelegramApi(
	apiCalls: TelegramApiCall[],
	options?: {
		beforeResolve?: (method: string, payload: unknown) => Promise<void> | void;
	},
): () => void {
	const originalCallApi = Telegram.prototype.callApi;
	let nextMessageId = PROGRESS_MESSAGE_ID;

	Reflect.set(Telegram.prototype, "callApi", async (method: string, payload: unknown) => {
		apiCalls.push({ method, payload });
		await options?.beforeResolve?.(method, payload);
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
	let selectedSession: StoredSelectedSession | undefined;
	let botOwnedSessionPin: StoredBotOwnedSessionPin | undefined;
	let modelRecency = createEmptyAppState("/workspace").modelRecency;
	let scheduledTasks = createEmptyAppState("/workspace").scheduledTasks;

	return {
		load: async (workspacePath: string) => ({
			...createEmptyAppState(workspacePath),
			selectedSession,
			botOwnedSessionPin,
			modelRecency,
			scheduledTasks,
		}),
		saveSelectedSession: async (_workspacePath: string, nextSelectedSession: StoredSelectedSession) => {
			selectedSession = nextSelectedSession;
		},
		clearSelectedSession: async (_workspacePath: string) => {
			selectedSession = undefined;
		},
		saveBotOwnedSessionPin: async (_workspacePath: string, nextBotOwnedSessionPin: StoredBotOwnedSessionPin) => {
			botOwnedSessionPin = nextBotOwnedSessionPin;
		},
		clearBotOwnedSessionPin: async (_workspacePath: string) => {
			botOwnedSessionPin = undefined;
		},
		saveModelRecency: async (_workspacePath: string, nextModelRecency) => {
			modelRecency = nextModelRecency;
		},
		saveScheduledTasks: async (_workspacePath: string, nextScheduledTasks) => {
			scheduledTasks = nextScheduledTasks;
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

function createPromptUpdate(text: string, updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text,
		},
	};
}

function createCommandUpdate(command: string, updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text: command,
			entities: [
				{
					offset: 0,
					length: command.split(" ")[0]?.length ?? command.length,
					type: "bot_command",
				},
			],
		},
	};
}

function createPhotoUpdate(caption: string | undefined, updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 11,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			...(caption !== undefined ? { caption } : {}),
			photo: [
				{ file_id: "photo-small", file_unique_id: "photo-small-unique", width: 64, height: 64, file_size: 1200 },
				{ file_id: "photo-large", file_unique_id: "photo-large-unique", width: 256, height: 256, file_size: 6400 },
			],
		},
	};
}

function createAudioUpdate(updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 12,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			audio: {
				duration: 1,
				file_id: "audio-meeting",
				file_unique_id: "audio-meeting-unique",
				file_name: "meeting.m4a",
				mime_type: "audio/mp4",
				file_size: 4096,
			},
		},
	};
}

function createDocumentUpdate(options: { fileName: string; mimeType: string; caption?: string }, updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 13,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			...(options.caption !== undefined ? { caption: options.caption } : {}),
			document: {
				file_id: `document-${options.fileName}`,
				file_unique_id: `document-unique-${options.fileName}`,
				file_name: options.fileName,
				mime_type: options.mimeType,
				file_size: 2048,
			},
		},
	};
}

function createVoiceUpdate(updateId = 1): Update {
	return {
		update_id: updateId,
		message: {
			message_id: 14,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			voice: {
				duration: 1,
				file_id: "voice-note",
				file_unique_id: "voice-note-unique",
				mime_type: "audio/ogg",
				file_size: 2048,
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

class MockPiRuntimeFactory implements PiRuntimeFactory {
	private readonly sessions = new Map<string, MockPiSession>();
	private nextSessionNumber = 1;

	async createRuntime(options: { workspacePath: string; selectedSessionPath?: string }): Promise<PiRuntimePort> {
		const sessionPath = options.selectedSessionPath ?? this.createSessionPath(options.workspacePath);
		const session = this.getOrCreateSession(sessionPath, options.workspacePath);
		return new MockPiRuntime(this, options.workspacePath, session);
	}

	async listSessions(workspacePath: string): Promise<SessionInfoRecord[]> {
		return Array.from(this.sessions.values())
			.filter((session) => session.cwd === workspacePath)
			.map((session) => session.toSessionInfo())
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async getPersistedUserPromptCount(sessionPath: string): Promise<number | undefined> {
		return this.sessions.get(sessionPath)?.messages.length ?? 0;
	}

	async updateSessionName(sessionPath: string, name: string): Promise<void> {
		const session = this.sessions.get(sessionPath);
		if (!session) {
			throw new Error(`Unknown session ${sessionPath}`);
		}
		session.setSessionName(name);
	}

	async refineSessionTitle(_request: SessionTitleRefinementRequest): Promise<string | undefined> {
		return undefined;
	}

	getSession(path: string): MockPiSession | undefined {
		return this.sessions.get(path);
	}

	createNextSession(workspacePath: string): MockPiSession {
		return this.getOrCreateSession(this.createSessionPath(workspacePath), workspacePath);
	}

	openSession(path: string, workspacePath: string): MockPiSession {
		return this.getOrCreateSession(path, workspacePath);
	}

	private getOrCreateSession(path: string, workspacePath: string): MockPiSession {
		const existing = this.sessions.get(path);
		if (existing) {
			return existing;
		}

		const session = new MockPiSession(path, workspacePath, `s${this.nextSessionNumber}-session`);
		this.nextSessionNumber += 1;
		this.sessions.set(path, session);
		return session;
	}

	private createSessionPath(workspacePath: string): string {
		return join(workspacePath, `.session-${this.nextSessionNumber}.jsonl`);
	}
}

class MockPiRuntime implements PiRuntimePort {
	constructor(
		private readonly factory: MockPiRuntimeFactory,
		private readonly workspacePath: string,
		private currentSession: MockPiSession,
	) {}

	get session(): PiSessionPort {
		return this.currentSession;
	}

	async newSession(): Promise<void> {
		this.currentSession = this.factory.createNextSession(this.workspacePath);
	}

	async switchSession(sessionPath: string): Promise<void> {
		this.currentSession = this.factory.openSession(sessionPath, this.workspacePath);
	}

	async dispose(): Promise<void> {
		return;
	}
}

class MockPiSession implements PiSessionPort {
	readonly messages: string[] = [];
	readonly promptPayloads: PiPromptContent[] = [];
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	sessionName: string | undefined;
	modified = new Date();
	private readonly listeners = new Set<PiSessionEventListener>();
	private queuedPromptEvents: PiSessionEvent[] = [];
	private streaming = false;
	private pausedPrompt: Deferred<void> | undefined;
	private nextPromptFailure: Error | undefined;

	constructor(path: string, cwd: string, sessionId: string) {
		this.sessionFile = path;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	get activeModel(): PiModelDescriptor | undefined {
		return undefined;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	subscribe(listener: PiSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async listAvailableModels(): Promise<PiModelDescriptor[]> {
		return [];
	}

	async setActiveModel(_model: PiModelDescriptor): Promise<void> {
		throw new Error("Unexpected setActiveModel call in progress test.");
	}

	setSessionName(name: string): void {
		this.sessionName = name;
		this.modified = new Date();
	}

	async sendUserMessage(content: PiPromptContent): Promise<void> {
		const textContent = normalizePromptText(content);
		this.streaming = true;
		for (const event of this.queuedPromptEvents) {
			this.emit(event);
		}
		this.queuedPromptEvents = [];

		if (this.pausedPrompt) {
			await this.pausedPrompt.promise;
		}

		if (!this.streaming) {
			return;
		}

		if (this.nextPromptFailure) {
			const error = this.nextPromptFailure;
			this.nextPromptFailure = undefined;
			this.streaming = false;
			throw error;
		}

		this.emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply:${textContent}` }],
			},
		});
		this.promptPayloads.push(content);
		this.messages.push(textContent);
		this.modified = new Date();
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply:${textContent}` }],
			},
		});
		this.streaming = false;
	}

	async abort(): Promise<void> {
		this.streaming = false;
		this.resumePausedPrompt();
	}

	queuePromptEvents(events: PiSessionEvent[]): void {
		this.queuedPromptEvents.push(...events);
	}

	pauseNextPrompt(): void {
		this.pausedPrompt = createDeferred<void>();
	}

	resumePausedPrompt(): void {
		this.pausedPrompt?.resolve();
		this.pausedPrompt = undefined;
	}

	failNextPrompt(error: Error): void {
		this.nextPromptFailure = error;
	}

	toSessionInfo(): SessionInfoRecord {
		return {
			path: this.sessionFile,
			id: this.sessionId,
			cwd: this.cwd,
			name: this.sessionName,
			created: this.modified,
			modified: this.modified,
			messageCount: this.messages.length,
			firstMessage: this.messages[0] ?? "(no messages)",
			allMessagesText: this.messages.join(" "),
		};
	}

	private emit(event: PiSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

interface TelegramApiCall {
	method: string;
	payload: unknown;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface InternalTelegrafBot {
	handleUpdate(update: Update): Promise<void>;
	botInfo?: unknown;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function normalizePromptText(content: PiPromptContent): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitFor(timeoutMs: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, timeoutMs);
	});
}

async function waitUntil(condition: () => boolean, timeoutMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}
		await waitFor(0);
		await flushAsyncWork();
	}

	if (!condition()) {
		throw new Error("Timed out waiting for asynchronous Telegram output.");
	}
}

function hasSentText(apiCalls: TelegramApiCall[], text: string): boolean {
	return apiCalls.some((call) => call.method === "sendMessage" && getPayloadText(call.payload) === text);
}

function hasProgressText(apiCalls: TelegramApiCall[], text: string): boolean {
	return apiCalls.some((call) => call.method === "editMessageText" && getPayloadText(call.payload) === text);
}

function countSentTexts(apiCalls: TelegramApiCall[], text: string): number {
	return apiCalls.filter((call) => call.method === "sendMessage" && getPayloadText(call.payload) === text).length;
}

function findApiCallIndex(apiCalls: TelegramApiCall[], method: string, text: string): number {
	return apiCalls.findIndex((call) => call.method === method && getPayloadText(call.payload) === text);
}

function getPayloadText(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || !("text" in payload)) {
		return undefined;
	}

	return typeof payload.text === "string" ? payload.text : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
