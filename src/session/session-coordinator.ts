import { basename } from "node:path";
import type {
	CurrentSessionModelSelection,
	PiModelDescriptor,
	PiRuntimeFactory,
	PiRuntimePort,
	SessionInfoRecord,
} from "../pi/pi-types.js";
import type {
	ScheduledPromptRunRequest,
	ScheduledPromptRunResult,
} from "../scheduler/scheduled-task-service.js";
import type {
	AppStateStore,
	StoredRecentModel,
	StoredSelectedSession,
} from "../state/app-state.js";
import {
	BusySessionError,
	InvalidSessionNameError,
	NoSelectedSessionError,
	SessionNotFoundError,
} from "./session-errors.js";
import { SessionEventBinding } from "./session-event-binding.js";
import { extractMessageText, isAssistantMessageEvent } from "./message-text.js";
import {
	generateHeuristicSessionTitle,
	selectRefinedSessionTitle,
} from "./session-title.js";
import { logHeuristicSessionTitle, logSessionTitleRefinementOutcome } from "./session-title-logging.js";

export interface SessionCatalogEntry extends SessionInfoRecord {
	activeModel?: PiModelDescriptor | undefined;
	isSelected: boolean;
	source: "pi" | "persisted";
}

export interface CurrentSessionEntry extends SessionCatalogEntry {
	userPromptCount?: number | undefined;
}

export interface BotStatus {
	workspacePath: string;
	busy: boolean;
	sessionCount: number;
	selectedSession: SessionCatalogEntry | undefined;
}

export interface PromptObserver {
	onPromptStarted?(session: SessionCatalogEntry): void;
	onProgress?(update: { eventType: string; summary: string }): void;
	onAssistantText?(text: string, done: boolean): void;
	onPromptFinished?(result: { sessionPath: string; assistantText: string; aborted: boolean }): void;
}

export interface PromptResult {
	sessionPath: string;
	assistantText: string;
	aborted: boolean;
}

export interface ActiveSessionInfo {
	path: string;
	id: string;
	name?: string | undefined;
}

export interface ActiveSessionObserver {
	onActiveSessionUpdated?(session: ActiveSessionInfo): void | Promise<void>;
}

export interface SessionCoordinatorOptions {
	titleRefinementTimeoutMs?: number;
}

interface ActiveRun {
	sessionPath: string;
	abortRequested: boolean;
}

export class SessionCoordinator {
	private static readonly DEFAULT_TITLE_REFINEMENT_TIMEOUT_MS = 15_000;

	private runtime: PiRuntimePort | undefined;
	private readonly eventBinding = new SessionEventBinding();
	private readonly activeSessionObservers = new Set<ActiveSessionObserver>();
	private readonly manuallyRenamedSessionPaths = new Set<string>();
	private selectedSession: StoredSelectedSession | undefined;
	private modelRecency: StoredRecentModel[] = [];
	private activeRun: ActiveRun | undefined;
	private initialized = false;
	private readonly titleRefinementTimeoutMs: number;

	constructor(
		private readonly workspacePath: string,
		private readonly stateStore: AppStateStore,
		private readonly runtimeFactory: PiRuntimeFactory,
		options?: SessionCoordinatorOptions,
	) {
		this.titleRefinementTimeoutMs =
			options?.titleRefinementTimeoutMs ?? SessionCoordinator.DEFAULT_TITLE_REFINEMENT_TIMEOUT_MS;
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		const state = await this.stateStore.load(this.workspacePath);
		this.selectedSession = state.selectedSession;
		this.modelRecency = state.modelRecency ?? [];

		if (this.selectedSession) {
			this.runtime = await this.runtimeFactory.createRuntime({
				workspacePath: this.workspacePath,
				selectedSessionPath: this.selectedSession.path,
			});
			await this.afterSessionReplacement(this.selectedSession.selectedAt);
		}

		this.initialized = true;
	}

	async listSessions(): Promise<SessionCatalogEntry[]> {
		const sessions = await this.runtimeFactory.listSessions(this.workspacePath);
		const selectedPath = this.selectedSession?.path;
		const activeSessionPath = this.runtime?.session.sessionFile;
		const activeModel = this.runtime?.session.activeModel;
		const catalog: SessionCatalogEntry[] = sessions.map((session) => ({
			...session,
			cwd: this.workspacePath,
			activeModel: session.path === activeSessionPath ? activeModel : undefined,
			isSelected: session.path === selectedPath,
			source: "pi" as const,
		}));

		if (this.selectedSession && !catalog.some((session) => session.path === this.selectedSession?.path)) {
			const selectedAt = new Date(this.selectedSession.selectedAt);
			catalog.unshift({
				path: this.selectedSession.path,
				id: this.selectedSession.sessionId,
				cwd: this.workspacePath,
				name: this.runtime?.session.sessionName,
				activeModel: this.runtime?.session.activeModel,
				created: selectedAt,
				modified: selectedAt,
				messageCount: 0,
				firstMessage: "(awaiting first assistant reply)",
				allMessagesText: "",
				isSelected: true,
				source: "persisted",
			});
		}

		return catalog;
	}

	async getCurrentSession(): Promise<SessionCatalogEntry | undefined> {
		if (!this.selectedSession) {
			return undefined;
		}

		return (await this.listSessions()).find((session) => session.path === this.selectedSession?.path);
	}

	async getCurrentSessionWithPromptCount(): Promise<CurrentSessionEntry | undefined> {
		const session = await this.getCurrentSession();
		if (!session) {
			return undefined;
		}

		let userPromptCount: number | undefined;
		try {
			userPromptCount = await this.runtimeFactory.getPersistedUserPromptCount(session.path);
		} catch {
			userPromptCount = undefined;
		}

		return {
			...session,
			userPromptCount,
		};
	}

	async getPersistedLastAssistantReply(sessionPath: string): Promise<string | undefined> {
		return this.runtimeFactory.getPersistedLastAssistantReply?.(sessionPath);
	}

	async getCurrentSessionModelSelection(): Promise<CurrentSessionModelSelection | undefined> {
		const runtime = await this.ensureRuntimeForSelectedSession();
		if (!runtime) {
			return undefined;
		}

		return {
			currentModel: runtime.session.activeModel,
			availableModels: orderModelsByRecency(await runtime.session.listAvailableModels(), this.modelRecency),
		};
	}

	async getStatus(): Promise<BotStatus> {
		const listedSessions = await this.runtimeFactory.listSessions(this.workspacePath);
		return {
			workspacePath: this.workspacePath,
			busy: this.isBusy(),
			sessionCount: listedSessions.length,
			selectedSession: await this.getCurrentSession(),
		};
	}

	async createNewSession(): Promise<SessionCatalogEntry> {
		this.assertIdle();

		if (!this.runtime) {
			this.runtime = await this.runtimeFactory.createRuntime({ workspacePath: this.workspacePath });
		} else {
			await this.runtime.newSession();
		}

		await this.afterSessionReplacement();
		return this.requireCurrentSession();
	}

	async switchSession(sessionPath: string): Promise<SessionCatalogEntry> {
		this.assertIdle();

		if (this.selectedSession?.path === sessionPath) {
			return this.requireCurrentSession();
		}

		if (!this.runtime) {
			this.runtime = await this.runtimeFactory.createRuntime({
				workspacePath: this.workspacePath,
				selectedSessionPath: sessionPath,
			});
		} else {
			await this.runtime.switchSession(sessionPath);
		}

		await this.afterSessionReplacement();
		return this.requireCurrentSession();
	}
	async switchSessionById(sessionId: string): Promise<SessionCatalogEntry> {
		const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
		if (!session) {
			throw new SessionNotFoundError(sessionId);
		}
		return this.switchSession(session.path);
	}

	async clearAllSessions(): Promise<SessionCatalogEntry> {
		this.assertIdle();
		await this.runtime?.dispose();
		this.runtime = undefined;
		if (!this.runtimeFactory.deleteAllSessions) {
			throw new Error("Pi runtime does not support deleting persisted sessions.");
		}

		await this.runtimeFactory.deleteAllSessions(this.workspacePath);
		this.selectedSession = undefined;
		this.manuallyRenamedSessionPaths.clear();
		await this.stateStore.clearSelectedSession(this.workspacePath);
		this.runtime = await this.runtimeFactory.createRuntime({ workspacePath: this.workspacePath });
		await this.afterSessionReplacement();
		return this.requireCurrentSession();
	}
	async setCurrentSessionModel(model: PiModelDescriptor): Promise<SessionCatalogEntry> {
		this.assertIdle();

		const runtime = await this.ensureRuntimeForSelectedSession();
		if (!runtime) {
			throw new NoSelectedSessionError();
		}

		await runtime.session.setActiveModel(model);
		const nextModelRecency = pushRecentModel(this.modelRecency, model);
		this.modelRecency = nextModelRecency;
		try {
			await this.stateStore.saveModelRecency(this.workspacePath, nextModelRecency);
		} catch (error) {
			console.warn(
				`[pi-telegram-bot] Failed to persist model recency for ${getModelKey(model)}: ${formatError(error)}`,
			);
		}
		return this.requireCurrentSession();
	}

	async renameCurrentSession(name: string): Promise<SessionCatalogEntry> {
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			throw new InvalidSessionNameError();
		}

		const runtime = await this.ensureRuntimeForSelectedSession();
		if (!runtime) {
			throw new NoSelectedSessionError();
		}

		const sessionPath = runtime.session.sessionFile;
		if (!sessionPath) {
			throw new Error("Pi runtime selected a non-persistent session, which is not supported by this bot.");
		}

		runtime.session.setSessionName(trimmedName);
		this.manuallyRenamedSessionPaths.add(sessionPath);
		this.emitCurrentActiveSessionUpdate();
		return this.requireCurrentSession();
	}

	async sendPrompt(text: string, observer?: PromptObserver): Promise<PromptResult> {
		this.assertIdle();
		const activeRun: ActiveRun = {
			sessionPath: this.selectedSession?.path ?? "pending-session-selection",
			abortRequested: false,
		};
		this.activeRun = activeRun;

		let selectedSession: SessionCatalogEntry | undefined;
		let unsubscribeAssistantEvents: (() => void) | undefined;
		let unsubscribeProgressEvents: (() => void) | undefined;

		let lastAssistantText = "";
		let finalDelivered = false;

		try {
			selectedSession = await this.ensureSelectedSession();
			activeRun.sessionPath = selectedSession.path;
			const initialTitle = this.isFirstPromptForSession(selectedSession)
				? this.applyHeuristicSessionTitle(text)
				: undefined;
			if (initialTitle) {
				selectedSession = {
					...selectedSession,
					name: initialTitle,
				};
			}
			if (activeRun.abortRequested) {
				const result: PromptResult = {
					sessionPath: selectedSession.path,
					assistantText: "",
					aborted: true,
				};
				observer?.onPromptFinished?.(result);
				return result;
			}
			const runtime = this.requireRuntime();

			unsubscribeAssistantEvents = this.eventBinding.addListener((event) => {
				if (!isAssistantMessageEvent(event)) {
					return;
				}

				const nextText = extractMessageText(event.message);
				lastAssistantText = nextText;
				const isFinal = event.type === "message_end";
				if (isFinal) {
					finalDelivered = true;
				}
				observer?.onAssistantText?.(nextText, isFinal);
			});

			unsubscribeProgressEvents = this.eventBinding.addProgressListener((update) => {
				observer?.onProgress?.(update);
			});

			observer?.onPromptStarted?.(selectedSession);
			const promptPromise = runtime.session.sendUserMessage(text);
			if (initialTitle) {
				this.scheduleSessionTitleRefinement({
					sessionPath: selectedSession.path,
					prompt: text,
					heuristicTitle: initialTitle,
				});
			}
			await promptPromise;
			if (!finalDelivered && lastAssistantText.length > 0) {
				observer?.onAssistantText?.(lastAssistantText, true);
			}
			const result: PromptResult = {
				sessionPath: selectedSession.path,
				assistantText: lastAssistantText,
				aborted: activeRun.abortRequested,
			};
			observer?.onPromptFinished?.(result);
			return result;
		} finally {
			unsubscribeAssistantEvents?.();
			unsubscribeProgressEvents?.();
			if (this.activeRun === activeRun) {
				this.activeRun = undefined;
			}
		}
	}

	async abortActiveRun(): Promise<boolean> {
		const activeRun = this.activeRun;
		if (!activeRun) {
			return false;
		}

		activeRun.abortRequested = true;
		if (!this.runtime) {
			return true;
		}

		await this.runtime.session.abort();
		return true;
	}
	isBusy(): boolean {
		return this.activeRun !== undefined;
	}

	async runScheduledPrompt(request: ScheduledPromptRunRequest): Promise<ScheduledPromptRunResult> {
		this.assertIdle();
		const runtime = await this.runtimeFactory.createRuntime({
			workspacePath: this.workspacePath,
			...(request.target.type === "existing_session"
				? { selectedSessionPath: request.target.sessionPath }
				: {}),
		});
		let unsubscribeAssistantEvents: (() => void) | undefined;
		let lastAssistantText = "";
		let finalDelivered = false;

		try {
			const sessionPath = runtime.session.sessionFile;
			if (!sessionPath) {
				throw new Error("Pi runtime created a non-persistent session, which is not supported by this bot.");
			}

			unsubscribeAssistantEvents = runtime.session.subscribe((event) => {
				if (!isAssistantMessageEvent(event)) {
					return;
				}

				lastAssistantText = extractMessageText(event.message);
				if (event.type === "message_end") {
					finalDelivered = true;
				}
			});

			if (request.target.type === "new_session") {
				const initialTitle = generateHeuristicSessionTitle(request.prompt);
				runtime.session.setSessionName(initialTitle);
				logHeuristicSessionTitle(initialTitle);
				this.scheduleSessionTitleRefinement({
					sessionPath,
					prompt: request.prompt,
					heuristicTitle: initialTitle,
				});
			}

			await runtime.session.sendUserMessage(request.prompt);
			if (!finalDelivered && lastAssistantText.length === 0) {
				lastAssistantText = "";
			}

			return {
				sessionPath,
				sessionId: runtime.session.sessionId,
				sessionName: runtime.session.sessionName,
				assistantText: lastAssistantText,
				activeModel: runtime.session.activeModel,
				target: request.target,
			};
		} finally {
			unsubscribeAssistantEvents?.();
			await runtime.dispose();
		}
	}

	async dispose(): Promise<void> {
		this.eventBinding.dispose();
		this.activeSessionObservers.clear();
		if (this.runtime) {
			await this.runtime.dispose();
			this.runtime = undefined;
		}
	}
	addActiveSessionObserver(observer: ActiveSessionObserver): () => void {
		this.activeSessionObservers.add(observer);
		return () => {
			this.activeSessionObservers.delete(observer);
		};
	}

	private async ensureSelectedSession(): Promise<SessionCatalogEntry> {
		if (!this.selectedSession) {
			if (!this.runtime) {
				this.runtime = await this.runtimeFactory.createRuntime({ workspacePath: this.workspacePath });
			} else {
				await this.runtime.newSession();
			}
			await this.afterSessionReplacement();
			return this.requireCurrentSession();
		}

		if (!this.runtime) {
			this.runtime = await this.runtimeFactory.createRuntime({
				workspacePath: this.workspacePath,
				selectedSessionPath: this.selectedSession.path,
			});
			await this.afterSessionReplacement(this.selectedSession.selectedAt);
		}

		return this.requireCurrentSession();
	}

	private async ensureRuntimeForSelectedSession(): Promise<PiRuntimePort | undefined> {
		if (!this.selectedSession) {
			return undefined;
		}

		if (!this.runtime) {
			this.runtime = await this.runtimeFactory.createRuntime({
				workspacePath: this.workspacePath,
				selectedSessionPath: this.selectedSession.path,
			});
			await this.afterSessionReplacement(this.selectedSession.selectedAt);
		}

		return this.runtime;
	}

	private requireRuntime(): PiRuntimePort {
		if (!this.runtime) {
			throw new Error("Pi runtime is not available.");
		}
		return this.runtime;
	}

	private isFirstPromptForSession(session: SessionCatalogEntry): boolean {
		return session.messageCount === 0 && !session.name;
	}

	private applyHeuristicSessionTitle(prompt: string): string {
		const title = generateHeuristicSessionTitle(prompt);
		this.requireRuntime().session.setSessionName(title);
		logHeuristicSessionTitle(title);
		this.emitCurrentActiveSessionUpdate();
		return title;
	}

	private scheduleSessionTitleRefinement(options: {
		sessionPath: string;
		prompt: string;
		heuristicTitle: string;
	}): void {
		void this.runSessionTitleRefinement(options).catch(() => undefined);
	}

	private async runSessionTitleRefinement(options: {
		sessionPath: string;
		prompt: string;
		heuristicTitle: string;
	}): Promise<void> {
		const safeCandidatePromise = this.runtimeFactory
			.refineSessionTitle({
				workspacePath: this.workspacePath,
				prompt: options.prompt,
				heuristicTitle: options.heuristicTitle,
				timeoutMs: this.titleRefinementTimeoutMs,
			})
			.catch(() => undefined);

		const candidateTitle = await withTimeout(safeCandidatePromise, this.titleRefinementTimeoutMs);
		if (!candidateTitle) {
			return;
		}

		if (this.manuallyRenamedSessionPaths.has(options.sessionPath)) {
			return;
		}

		const refinedTitle = selectRefinedSessionTitle({
			prompt: options.prompt,
			heuristicTitle: options.heuristicTitle,
			candidateTitle,
		});
		if (!refinedTitle) {
			logSessionTitleRefinementOutcome({
				outcome: "rejected",
				finalTitle: options.heuristicTitle,
				candidateTitle,
			});
			return;
		}

		try {
			if (this.selectedSession?.path === options.sessionPath && this.runtime) {
				this.runtime.session.setSessionName(refinedTitle);
				this.emitCurrentActiveSessionUpdate();
				logSessionTitleRefinementOutcome({
					outcome: "accepted",
					finalTitle: refinedTitle,
				});
				return;
			}

			await this.runtimeFactory.updateSessionName(options.sessionPath, refinedTitle);
			logSessionTitleRefinementOutcome({
				outcome: "accepted",
				finalTitle: refinedTitle,
			});
		} catch (error) {
			logSessionTitleRefinementOutcome({
				outcome: "failed",
				finalTitle: options.heuristicTitle,
			});
			throw error;
		}
	}

	private async afterSessionReplacement(selectedAt?: string): Promise<void> {
		const runtime = this.requireRuntime();
		const sessionPath = runtime.session.sessionFile;
		if (!sessionPath) {
			throw new Error("Pi runtime created a non-persistent session, which is not supported by this bot.");
		}

		this.eventBinding.rebind(runtime.session);
		this.selectedSession = {
			path: sessionPath,
			sessionId: runtime.session.sessionId,
			selectedAt: selectedAt ?? new Date().toISOString(),
		};
		await this.stateStore.saveSelectedSession(this.workspacePath, this.selectedSession);
		this.emitCurrentActiveSessionUpdate();
	}

	private emitCurrentActiveSessionUpdate(): void {
		if (!this.runtime) {
			return;
		}

		const sessionPath = this.runtime.session.sessionFile;
		if (!sessionPath) {
			return;
		}

		const activeSession: ActiveSessionInfo = {
			path: sessionPath,
			id: this.runtime.session.sessionId,
			name: this.runtime.session.sessionName,
		};

		for (const observer of this.activeSessionObservers) {
			void Promise.resolve(observer.onActiveSessionUpdated?.(activeSession)).catch((error) => {
				console.error("[pi-telegram-bot] Active session observer failed:", error);
			});
		}
	}

	private async requireCurrentSession(): Promise<SessionCatalogEntry> {
		const current = await this.getCurrentSession();
		if (!current) {
			throw new SessionNotFoundError(this.selectedSession?.path ?? basename(this.workspacePath));
		}
		return current;
	}

	private assertIdle(): void {
		if (this.isBusy()) {
			throw new BusySessionError();
		}
	}
}

function orderModelsByRecency(
	availableModels: readonly PiModelDescriptor[],
	modelRecency: readonly StoredRecentModel[],
): PiModelDescriptor[] {
	if (availableModels.length <= 1 || modelRecency.length === 0) {
		return [...availableModels];
	}

	const orderedModels: PiModelDescriptor[] = [];
	const includedModelKeys = new Set<string>();
	const availableModelsByKey = new Map(availableModels.map((model) => [getModelKey(model), model]));

	for (const recentModel of modelRecency) {
		const key = getModelKey(recentModel);
		const availableModel = availableModelsByKey.get(key);
		if (!availableModel || includedModelKeys.has(key)) {
			continue;
		}

		orderedModels.push(availableModel);
		includedModelKeys.add(key);
	}

	for (const model of availableModels) {
		const key = getModelKey(model);
		if (includedModelKeys.has(key)) {
			continue;
		}

		orderedModels.push(model);
	}

	return orderedModels;
}

function pushRecentModel(
	modelRecency: readonly StoredRecentModel[],
	model: PiModelDescriptor,
): StoredRecentModel[] {
	const recentModel = toStoredRecentModel(model);
	const recentModelKey = getModelKey(recentModel);

	return [recentModel, ...modelRecency.filter((entry) => getModelKey(entry) !== recentModelKey)];
}

function toStoredRecentModel(model: PiModelDescriptor): StoredRecentModel {
	return {
		provider: model.provider,
		id: model.id,
	};
}

function getModelKey(model: PiModelDescriptor | StoredRecentModel): string {
	return `${model.provider}/${model.id}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<undefined>((resolve) => {
		timeoutHandle = setTimeout(() => {
			resolve(undefined);
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}
