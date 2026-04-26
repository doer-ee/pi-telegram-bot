import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../src/config/app-config.js";
import type {
	PiModelDescriptor,
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

		expect(apiCalls).toEqual([
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

		await coordinator.dispose();
	});
});

function interceptTelegramApi(apiCalls: TelegramApiCall[]): () => void {
	const originalCallApi = Telegram.prototype.callApi;
	let nextMessageId = PROGRESS_MESSAGE_ID;

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
	let selectedSession: StoredSelectedSession | undefined;
	let botOwnedSessionPin: StoredBotOwnedSessionPin | undefined;

	return {
		load: async (workspacePath: string) => ({
			...createEmptyAppState(workspacePath),
			selectedSession,
			botOwnedSessionPin,
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

function createPromptUpdate(text: string): Update {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1,
			chat: createPrivateChat(),
			from: createAuthorizedUser(),
			text,
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
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	sessionName: string | undefined;
	modified = new Date();
	private readonly listeners = new Set<PiSessionEventListener>();
	private queuedPromptEvents: PiSessionEvent[] = [];
	private streaming = false;

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

	setSessionName(name: string): void {
		this.sessionName = name;
		this.modified = new Date();
	}

	async sendUserMessage(content: string): Promise<void> {
		this.streaming = true;
		for (const event of this.queuedPromptEvents) {
			this.emit(event);
		}
		this.queuedPromptEvents = [];
		this.emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply:${content}` }],
			},
		});
		this.messages.push(content);
		this.modified = new Date();
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply:${content}` }],
			},
		});
		this.streaming = false;
	}

	async abort(): Promise<void> {
		this.streaming = false;
	}

	queuePromptEvents(events: PiSessionEvent[]): void {
		this.queuedPromptEvents.push(...events);
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

interface InternalTelegrafBot {
	handleUpdate(update: Update): Promise<void>;
	botInfo?: unknown;
}
