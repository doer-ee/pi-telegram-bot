export interface StoredSelectedSession {
	path: string;
	sessionId: string;
	selectedAt: string;
}

export interface StoredBotOwnedSessionPin {
	chatId: number;
	messageId: number;
	sessionPath: string;
	text: string;
}

export interface AppState {
	version: 1;
	workspacePath: string;
	selectedSession?: StoredSelectedSession | undefined;
	botOwnedSessionPin?: StoredBotOwnedSessionPin | undefined;
}

export interface AppStateStore {
	load(workspacePath: string): Promise<AppState>;
	saveSelectedSession(workspacePath: string, selectedSession: StoredSelectedSession): Promise<void>;
	clearSelectedSession(workspacePath: string): Promise<void>;
	saveBotOwnedSessionPin(workspacePath: string, botOwnedSessionPin: StoredBotOwnedSessionPin): Promise<void>;
	clearBotOwnedSessionPin(workspacePath: string): Promise<void>;
}

export function createEmptyAppState(workspacePath: string): AppState {
	return {
		version: 1,
		workspacePath,
	};
}
