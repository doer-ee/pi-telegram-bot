import type { ScheduledTask } from "../scheduler/scheduled-task-types.js";

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

export interface StoredRecentModel {
	provider: string;
	id: string;
}

export interface AppState {
	version: 2;
	workspacePath: string;
	selectedSession?: StoredSelectedSession | undefined;
	botOwnedSessionPin?: StoredBotOwnedSessionPin | undefined;
	modelRecency?: StoredRecentModel[] | undefined;
	scheduledTasks?: ScheduledTask[] | undefined;
}

export interface AppStateStore {
	load(workspacePath: string): Promise<AppState>;
	saveSelectedSession(workspacePath: string, selectedSession: StoredSelectedSession): Promise<void>;
	clearSelectedSession(workspacePath: string): Promise<void>;
	saveBotOwnedSessionPin(workspacePath: string, botOwnedSessionPin: StoredBotOwnedSessionPin): Promise<void>;
	clearBotOwnedSessionPin(workspacePath: string): Promise<void>;
	saveModelRecency(workspacePath: string, modelRecency: StoredRecentModel[]): Promise<void>;
	saveScheduledTasks(workspacePath: string, scheduledTasks: ScheduledTask[]): Promise<void>;
}

export function createEmptyAppState(workspacePath: string): AppState {
	return {
		version: 2,
		workspacePath,
	};
}
