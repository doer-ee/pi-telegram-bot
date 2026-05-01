import { describe, expect, it } from "vitest";
import type { ActiveSessionInfo } from "../src/session/session-coordinator.js";
import type {
	AppState,
	AppStateStore,
	StoredBotOwnedSessionPin,
	StoredSelectedSession,
} from "../src/state/app-state.js";
import { createEmptyAppState } from "../src/state/app-state.js";
import { SessionPinSync } from "../src/telegram/session-pin-sync.js";
import type { TelegramMessageClient, TelegramTextOptions } from "../src/telegram/telegram-message-client.js";

describe("SessionPinSync", () => {
	it("replaces the previous bot-owned session pin and deletes the old pin message", async () => {
		const workspacePath = "/workspace";
		const stateStore = new InMemoryAppStateStore(workspacePath);
		const client = new MockTelegramMessageClient();
		const sync = new SessionPinSync(client, stateStore, workspacePath, 42);

		await sync.initialize();
		await sync.syncActiveSession(createSession("/session-a.jsonl", "session-a", "Session A"));
		await sync.syncActiveSession(createSession("/session-b.jsonl", "session-b", "Session B"));

		expect(client.operations).toEqual([
			"send:1:Active session: Session A",
			"pin:1",
			"send:2:Active session: Session B",
			"pin:2",
			"unpin:1",
			"delete:1",
		]);
		expect(client.getVisibleTexts()).toEqual(["Active session: Session B"]);
		expect((await stateStore.load(workspacePath)).botOwnedSessionPin).toEqual({
			chatId: 42,
			messageId: 2,
			sessionPath: "/session-b.jsonl",
			text: "Active session: Session B",
		});
	});

	it("keeps the prior pin when Telegram rejects pinning the replacement message", async () => {
		const workspacePath = "/workspace";
		const stateStore = new InMemoryAppStateStore(workspacePath);
		const client = new MockTelegramMessageClient();
		const sync = new SessionPinSync(client, stateStore, workspacePath, 42);

		await sync.initialize();
		await sync.syncActiveSession(createSession("/session-a.jsonl", "session-a", "Session A"));
		client.failPinForMessageId = 2;

		await expect(
			sync.syncActiveSession(createSession("/session-b.jsonl", "session-b", "Session B")),
		).resolves.toBeUndefined();

		expect(client.operations).toEqual([
			"send:1:Active session: Session A",
			"pin:1",
			"send:2:Active session: Session B",
			"pin:2",
			"delete:2",
		]);
		expect(client.getVisibleTexts()).toEqual(["Active session: Session A"]);
		expect((await stateStore.load(workspacePath)).botOwnedSessionPin).toEqual({
			chatId: 42,
			messageId: 1,
			sessionPath: "/session-a.jsonl",
			text: "Active session: Session A",
		});
	});

	it("continues cleanly when Telegram rejects unpinning the previous session message", async () => {
		const workspacePath = "/workspace";
		const stateStore = new InMemoryAppStateStore(workspacePath);
		const client = new MockTelegramMessageClient();
		const sync = new SessionPinSync(client, stateStore, workspacePath, 42);

		await sync.initialize();
		await sync.syncActiveSession(createSession("/session-a.jsonl", "session-a", "Session A"));
		client.failUnpinForMessageId = 1;

		await expect(
			sync.syncActiveSession(createSession("/session-b.jsonl", "session-b", "Session B")),
		).resolves.toBeUndefined();

		expect(client.operations).toEqual([
			"send:1:Active session: Session A",
			"pin:1",
			"send:2:Active session: Session B",
			"pin:2",
			"unpin:1",
			"delete:1",
		]);
		expect(client.getVisibleTexts()).toEqual(["Active session: Session B"]);
		expect((await stateStore.load(workspacePath)).botOwnedSessionPin).toEqual({
			chatId: 42,
			messageId: 2,
			sessionPath: "/session-b.jsonl",
			text: "Active session: Session B",
		});
	});
});

function createSession(path: string, id: string, name?: string): ActiveSessionInfo {
	return {
		path,
		id,
		name,
	};
}

class InMemoryAppStateStore implements AppStateStore {
	private state: AppState;

	constructor(workspacePath: string) {
		this.state = createEmptyAppState(workspacePath);
	}

	async load(workspacePath: string): Promise<AppState> {
		if (this.state.workspacePath !== workspacePath) {
			return createEmptyAppState(workspacePath);
		}

		return structuredClone(this.state);
	}

	async saveSelectedSession(workspacePath: string, selectedSession: StoredSelectedSession): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			selectedSession,
		};
	}

	async clearSelectedSession(workspacePath: string): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			selectedSession: undefined,
		};
	}

	async saveBotOwnedSessionPin(workspacePath: string, botOwnedSessionPin: StoredBotOwnedSessionPin): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			botOwnedSessionPin,
		};
	}

	async clearBotOwnedSessionPin(workspacePath: string): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			botOwnedSessionPin: undefined,
		};
	}
	async saveModelRecency(
		workspacePath: string,
		modelRecency: NonNullable<AppState["modelRecency"]>,
	): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			modelRecency,
		};
	}

	async saveScheduledTasks(
		workspacePath: string,
		scheduledTasks: NonNullable<AppState["scheduledTasks"]>,
	): Promise<void> {
		const state = await this.load(workspacePath);
		this.state = {
			...state,
			scheduledTasks,
		};
	}
}

class MockTelegramMessageClient implements TelegramMessageClient {
	private nextMessageId = 1;
	private readonly messages = new Map<number, { text: string; deleted: boolean }>();
	readonly operations: string[] = [];
	failPinForMessageId: number | undefined;
	failUnpinForMessageId: number | undefined;

	async sendText(_chatId: number, text: string, _options?: TelegramTextOptions): Promise<number> {
		const messageId = this.nextMessageId;
		this.nextMessageId += 1;
		this.messages.set(messageId, { text, deleted: false });
		this.operations.push(`send:${messageId}:${text}`);
		return messageId;
	}

	async editText(_chatId: number, messageId: number, text: string, _options?: TelegramTextOptions): Promise<void> {
		const message = this.messages.get(messageId);
		if (!message || message.deleted) {
			throw new Error(`Cannot edit missing message ${messageId}`);
		}

		message.text = text;
	}

	async deleteText(_chatId: number, messageId: number): Promise<void> {
		this.operations.push(`delete:${messageId}`);
		const message = this.messages.get(messageId);
		if (!message || message.deleted) {
			return;
		}

		message.deleted = true;
	}

	async pinText(_chatId: number, messageId: number): Promise<void> {
		this.operations.push(`pin:${messageId}`);
		if (this.failPinForMessageId === messageId) {
			throw new Error(`Cannot pin message ${messageId}`);
		}
	}

	async unpinText(_chatId: number, messageId: number): Promise<void> {
		this.operations.push(`unpin:${messageId}`);
		if (this.failUnpinForMessageId === messageId) {
			throw new Error(`Cannot unpin message ${messageId}`);
		}
	}

	getVisibleTexts(): string[] {
		return Array.from(this.messages.entries())
			.filter(([, message]) => !message.deleted)
			.sort(([leftId], [rightId]) => leftId - rightId)
			.map(([, message]) => message.text);
	}
}
