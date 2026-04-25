import type { ActiveSessionInfo } from "../session/session-coordinator.js";
import type { AppStateStore, StoredBotOwnedSessionPin } from "../state/app-state.js";
import type { TelegramMessageClient } from "./telegram-message-client.js";

export class SessionPinSync {
	private currentPin: StoredBotOwnedSessionPin | undefined;
	private pending: Promise<void> = Promise.resolve();
	private initialized = false;

	constructor(
		private readonly messageClient: TelegramMessageClient,
		private readonly stateStore: AppStateStore,
		private readonly workspacePath: string,
		private readonly chatId: number,
	) {}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		const state = await this.stateStore.load(this.workspacePath);
		this.currentPin = state.botOwnedSessionPin;
		this.initialized = true;
	}

	syncActiveSession(session: ActiveSessionInfo | undefined): Promise<void> {
		const nextSync = this.pending
			.then(async () => {
				await this.ensureInitialized();

				if (!session?.name) {
					await this.clearCurrentPin();
					return;
				}

				const text = formatSessionPinText(session.name);
				if (
					this.currentPin &&
					this.currentPin.sessionPath === session.path &&
					this.currentPin.text === text
				) {
					return;
				}

				await this.replaceCurrentPin({
					chatId: this.chatId,
					sessionPath: session.path,
					text,
				});
			})
			.catch((error) => {
				console.warn("[pi-telegram-bot] Session pin sync failed:", error);
			});

		this.pending = nextSync;
		return nextSync;
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}
	}

	private async replaceCurrentPin(nextPin: {
		chatId: number;
		sessionPath: string;
		text: string;
	}): Promise<void> {
		const previousPin = this.currentPin;
		let nextMessageId: number | undefined;

		try {
			nextMessageId = await this.messageClient.sendText(nextPin.chatId, nextPin.text);
			await this.messageClient.pinText(nextPin.chatId, nextMessageId);
		} catch (error) {
			if (nextMessageId !== undefined) {
				await this.safeDelete(nextPin.chatId, nextMessageId, "delete unsynced session pin message");
			}
			throw error;
		}

		if (nextMessageId === undefined) {
			throw new Error("Telegram did not return a session pin message id.");
		}

		const storedPin: StoredBotOwnedSessionPin = {
			chatId: nextPin.chatId,
			messageId: nextMessageId,
			sessionPath: nextPin.sessionPath,
			text: nextPin.text,
		};

		this.currentPin = storedPin;
		await this.saveCurrentPin(storedPin);

		if (previousPin && previousPin.messageId !== nextMessageId) {
			await this.cleanupPin(previousPin);
		}
	}

	private async clearCurrentPin(): Promise<void> {
		const currentPin = this.currentPin;
		if (!currentPin) {
			return;
		}

		this.currentPin = undefined;
		await this.clearStoredPin();
		await this.cleanupPin(currentPin);
	}

	private async cleanupPin(pin: StoredBotOwnedSessionPin): Promise<void> {
		await this.safeUnpin(pin.chatId, pin.messageId, "unpin previous session pin message");
		await this.safeDelete(pin.chatId, pin.messageId, "delete previous session pin message");
	}

	private async saveCurrentPin(pin: StoredBotOwnedSessionPin): Promise<void> {
		try {
			await this.stateStore.saveBotOwnedSessionPin(this.workspacePath, pin);
		} catch (error) {
			console.warn("[pi-telegram-bot] Failed to persist session pin state:", error);
		}
	}

	private async clearStoredPin(): Promise<void> {
		try {
			await this.stateStore.clearBotOwnedSessionPin(this.workspacePath);
		} catch (error) {
			console.warn("[pi-telegram-bot] Failed to clear session pin state:", error);
		}
	}

	private async safeUnpin(chatId: number, messageId: number, action: string): Promise<void> {
		try {
			await this.messageClient.unpinText(chatId, messageId);
		} catch (error) {
			console.warn(`[pi-telegram-bot] Failed to ${action}:`, error);
		}
	}

	private async safeDelete(chatId: number, messageId: number, action: string): Promise<void> {
		try {
			await this.messageClient.deleteText(chatId, messageId);
		} catch (error) {
			console.warn(`[pi-telegram-bot] Failed to ${action}:`, error);
		}
	}
}

function formatSessionPinText(sessionName: string): string {
	return `Active session: ${sessionName}`;
}
