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

export interface PiSessionEvent {
	type: string;
	message?: SessionMessageLike;
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
