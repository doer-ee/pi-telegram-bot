export interface SessionInfoRecord {
	path: string;
	id: string;
	cwd: string;
	name?: string | undefined;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export interface SessionTitleRefinementRequest {
	workspacePath: string;
	prompt: string;
	heuristicTitle: string;
	timeoutMs: number;
}

export interface SessionMessagePart {
	type: string;
	text?: string;
}

export interface SessionMessageLike {
	role: string;
	content?: string | SessionMessagePart[];
	stopReason?: string;
}

export interface PiAssistantMessageEvent {
	type?: string;
	delta?: string;
	partial?: string;
	text?: string;
	[key: string]: unknown;
}

export interface PiSessionEvent {
	type: string;
	message?: SessionMessageLike;
	assistantMessageEvent?: PiAssistantMessageEvent;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	input?: Record<string, unknown>;
	result?: unknown;
	partialResult?: unknown;
	isError?: boolean;
	steering?: readonly string[];
	followUp?: readonly string[];
	reason?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
	[key: string]: unknown;
}

export type PiSessionEventListener = (event: PiSessionEvent) => void;

export interface PiSessionPort {
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly isStreaming: boolean;
	subscribe(listener: PiSessionEventListener): () => void;
	setSessionName(name: string): void;
	sendUserMessage(content: string): Promise<void>;
	abort(): Promise<void>;
}

export interface PiRuntimePort {
	readonly session: PiSessionPort;
	newSession(): Promise<void>;
	switchSession(sessionPath: string): Promise<void>;
	dispose(): Promise<void>;
}

export interface PiRuntimeFactory {
	createRuntime(options: { workspacePath: string; selectedSessionPath?: string }): Promise<PiRuntimePort>;
	listSessions(workspacePath: string): Promise<SessionInfoRecord[]>;
	updateSessionName(sessionPath: string, name: string): Promise<void>;
	refineSessionTitle(request: SessionTitleRefinementRequest): Promise<string | undefined>;
}
