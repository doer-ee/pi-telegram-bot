import { readFile } from "node:fs/promises";
import {
	type AgentSessionEvent,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { DEFAULT_TITLE_REFINEMENT_MODEL } from "../config/title-refinement-model.js";
import { ModelNotAvailableError } from "./pi-errors.js";
import type {
	BackgroundAssistantPromptRequest,
	PiModelDescriptor,
	PiRuntimeFactory,
	PiRuntimePort,
	PiSessionEvent,
	PiSessionEventListener,
	PiSessionPort,
	SessionTitleRefinementRequest,
	SessionInfoRecord,
} from "./pi-types.js";
import { runSessionTitleRefinementWithTimeout } from "./session-title-refinement.js";
import { buildSessionTitleRefinementPrompt } from "../session/session-title.js";
import {
	logResolvedSessionTitleRefinementModel,
	logSessionTitleRefinementOutcome,
} from "../session/session-title-logging.js";

export class PiSdkRuntimeFactory implements PiRuntimeFactory {
	private readonly agentDir: string;
	private readonly titleRefinementModel: string;

	constructor(agentDir?: string, titleRefinementModel: string = DEFAULT_TITLE_REFINEMENT_MODEL) {
		this.agentDir = agentDir ?? getAgentDir();
		this.titleRefinementModel = titleRefinementModel;
	}

	async createRuntime(options: { workspacePath: string; selectedSessionPath?: string }): Promise<PiRuntimePort> {
		const sessionManager = options.selectedSessionPath
			? SessionManager.open(options.selectedSessionPath, undefined, options.workspacePath)
			: SessionManager.create(options.workspacePath);

		const createRuntimeFactory: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager: nextSessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: this.agentDir,
			});
			const sessionOptions = {
				services,
				sessionManager: nextSessionManager,
				...(sessionStartEvent ? { sessionStartEvent } : {}),
			};

			return {
				...(await createAgentSessionFromServices(sessionOptions)),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntimeFactory, {
			cwd: options.workspacePath,
			agentDir: this.agentDir,
			sessionManager,
		});

		await runtime.session.bindExtensions({});
		throwOnDiagnosticErrors(runtime.diagnostics);
		logDiagnosticWarnings(runtime.diagnostics);
		return new PiSdkRuntimeAdapter(runtime, options.workspacePath);
	}

	async listSessions(workspacePath: string): Promise<SessionInfoRecord[]> {
		return SessionManager.list(workspacePath);
	}

	async getPersistedUserPromptCount(sessionPath: string): Promise<number | undefined> {
		return countPersistedUserPromptEntries(sessionPath);
	}

	async updateSessionName(sessionPath: string, name: string): Promise<void> {
		SessionManager.open(sessionPath).appendSessionInfo(name);
	}

	async refineSessionTitle(request: SessionTitleRefinementRequest): Promise<string | undefined> {
		try {
			const services = await createAgentSessionServices({
				cwd: request.workspacePath,
				agentDir: this.agentDir,
			});
			throwOnDiagnosticErrors(services.diagnostics);
			logDiagnosticWarnings(services.diagnostics);
			const model = resolveConfiguredTitleRefinementModel(
				services.modelRegistry,
				this.titleRefinementModel,
			);
			logResolvedSessionTitleRefinementModel(model.provider, model.id);

			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(request.workspacePath),
				model,
				thinkingLevel: "low",
				noTools: "all",
			});

			const refinementResult = await runSessionTitleRefinementWithTimeout({
				session,
				prompt: buildSessionTitleRefinementPrompt(request.prompt, request.heuristicTitle),
				timeoutMs: request.timeoutMs,
			});

			if (refinementResult.status === "timed_out") {
				logSessionTitleRefinementOutcome({
					outcome: "timed out",
					finalTitle: request.heuristicTitle,
				});
				return undefined;
			}

			if (!refinementResult.candidateTitle) {
				logSessionTitleRefinementOutcome({
					outcome: "unavailable",
					finalTitle: request.heuristicTitle,
				});
				return undefined;
			}

			return refinementResult.candidateTitle;
		} catch (error) {
			logSessionTitleRefinementOutcome({
				outcome: error instanceof TitleRefinementUnavailableError ? "unavailable" : "failed",
				finalTitle: request.heuristicTitle,
			});
			throw error;
		}
	}

	async runBackgroundAssistantPrompt(request: BackgroundAssistantPromptRequest): Promise<string | undefined> {
		const services = await createAgentSessionServices({
			cwd: request.workspacePath,
			agentDir: this.agentDir,
		});
		throwOnDiagnosticErrors(services.diagnostics);
		logDiagnosticWarnings(services.diagnostics);
		const model = resolveConfiguredTitleRefinementModel(
			services.modelRegistry,
			this.titleRefinementModel,
		);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(request.workspacePath),
			model,
			thinkingLevel: "low",
			noTools: "all",
		});

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const promptPromise = (async () => {
			await session.bindExtensions({});
			await session.sendUserMessage(request.prompt);
			return session.getLastAssistantText()?.trim();
		})();

		const observedPromptPromise = promptPromise.catch((error: unknown) => {
			if (timedOut) {
				return undefined;
			}
			throw error;
		});

		const timeoutPromise = new Promise<string | undefined>((resolve) => {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				void session.abort().catch(() => undefined);
				resolve(undefined);
			}, request.timeoutMs);
		});

		try {
			return await Promise.race([observedPromptPromise, timeoutPromise]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			safeDisposeAssistantSession(session);
		}
	}
}

function resolveConfiguredTitleRefinementModel(
	modelRegistry: AgentSessionRuntime["services"]["modelRegistry"],
	modelReference: string,
): Model<Api> {
	const normalizedModelReference = modelReference.trim();
	const exactProviderMatch = findProviderQualifiedModel(modelRegistry, normalizedModelReference);
	if (exactProviderMatch) {
		return requireConfiguredTitleRefinementModelAuth(
			modelRegistry,
			exactProviderMatch,
			normalizedModelReference,
		);
	}

	const exactIdMatches = modelRegistry
		.getAvailable()
		.filter((model) => model.id === normalizedModelReference || `${model.provider}/${model.id}` === normalizedModelReference);

	if (exactIdMatches.length === 1) {
		const [match] = exactIdMatches;
		if (!match) {
			throw new TitleRefinementUnavailableError(
				`Configured title refinement model "${normalizedModelReference}" is not available.`,
			);
		}
		return requireConfiguredTitleRefinementModelAuth(modelRegistry, match, normalizedModelReference);
	}

	if (exactIdMatches.length > 1) {
		const deterministicDefaultMatch = selectDeterministicDefaultTitleRefinementMatch(
			exactIdMatches,
			normalizedModelReference,
		);
		if (deterministicDefaultMatch) {
			return requireConfiguredTitleRefinementModelAuth(
				modelRegistry,
				deterministicDefaultMatch,
				normalizedModelReference,
			);
		}

		throw new TitleRefinementUnavailableError(
			`Configured title refinement model "${normalizedModelReference}" is ambiguous. Matches: ${exactIdMatches.map((model) => `${model.provider}/${model.id}`).join(", ")}`,
		);
	}

	throw new TitleRefinementUnavailableError(
		`Configured title refinement model "${normalizedModelReference}" is not available.`,
	);
}

function requireConfiguredTitleRefinementModelAuth(
	modelRegistry: AgentSessionRuntime["services"]["modelRegistry"],
	model: Model<Api>,
	modelReference: string,
): Model<Api> {
	if (modelRegistry.hasConfiguredAuth(model)) {
		return model;
	}

	throw new TitleRefinementUnavailableError(
		`Configured title refinement model "${modelReference}" is missing auth configuration for ${model.provider}/${model.id}.`,
	);
}

function selectDeterministicDefaultTitleRefinementMatch(
	matches: readonly Model<Api>[],
	modelReference: string,
): Model<Api> | undefined {
	if (modelReference !== DEFAULT_TITLE_REFINEMENT_MODEL) {
		return undefined;
	}

	const preferredOpenAiMatch = matches.find((model) => model.provider === "openai");
	if (preferredOpenAiMatch) {
		return preferredOpenAiMatch;
	}

	return [...matches].sort(compareDeterministicTitleRefinementMatches)[0];
}

function compareDeterministicTitleRefinementMatches(left: Model<Api>, right: Model<Api>): number {
	return left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name);
}

function findProviderQualifiedModel(
	modelRegistry: AgentSessionRuntime["services"]["modelRegistry"],
	modelReference: string,
): Model<Api> | undefined {
	const providerSeparatorIndex = modelReference.indexOf("/");
	if (providerSeparatorIndex <= 0 || providerSeparatorIndex === modelReference.length - 1) {
		return undefined;
	}

	return modelRegistry.find(
		modelReference.slice(0, providerSeparatorIndex),
		modelReference.slice(providerSeparatorIndex + 1),
	);
}

async function countPersistedUserPromptEntries(sessionPath: string): Promise<number | undefined> {
	try {
		const content = await readFile(sessionPath, "utf8");
		return countUserPromptEntriesFromPersistedSession(content);
	} catch (error) {
		return isErrorWithCode(error, "ENOENT") ? 0 : undefined;
	}
}

function countUserPromptEntriesFromPersistedSession(content: string): number | undefined {
	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		return undefined;
	}

	let sawSessionHeader = false;
	let userPromptCount = 0;

	for (const line of lines) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return undefined;
		}

		if (!isRecord(entry) || typeof entry.type !== "string") {
			return undefined;
		}

		if (entry.type === "session") {
			sawSessionHeader = true;
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		if (!isRecord(entry.message) || typeof entry.message.role !== "string") {
			return undefined;
		}

		if (entry.message.role === "user") {
			userPromptCount += 1;
		}
	}

	return sawSessionHeader ? userPromptCount : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === code;
}

class TitleRefinementUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TitleRefinementUnavailableError";
	}
}

class PiSdkRuntimeAdapter implements PiRuntimePort {
	constructor(
		private readonly runtime: AgentSessionRuntime,
		private readonly workspacePath: string,
	) {}

	get session(): PiSessionPort {
		return new PiSdkSessionAdapter(this.runtime.session);
	}

	async newSession(): Promise<void> {
		const result = await this.runtime.newSession();
		if (result.cancelled) {
			throw new Error("Pi session creation was cancelled unexpectedly.");
		}
	}

	async switchSession(sessionPath: string): Promise<void> {
		const result = await this.runtime.switchSession(sessionPath, {
			cwdOverride: this.workspacePath,
		});
		if (result.cancelled) {
			throw new Error(`Pi session switch was cancelled unexpectedly for ${sessionPath}.`);
		}
	}

	async dispose(): Promise<void> {
		await this.runtime.dispose();
	}
}

class PiSdkSessionAdapter implements PiSessionPort {
	constructor(private readonly session: AgentSessionRuntime["session"]) {}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get sessionId(): string {
		return this.session.sessionId;
	}

	get sessionName(): string | undefined {
		return this.session.sessionName;
	}

	get activeModel(): PiModelDescriptor | undefined {
		const model = this.session.model;
		if (!model) {
			return undefined;
		}

		return {
			provider: model.provider,
			id: model.id,
		};
	}

	get isStreaming(): boolean {
		return this.session.isStreaming;
	}

	subscribe(listener: PiSessionEventListener): () => void {
		return this.session.subscribe((event: AgentSessionEvent) => {
			listener(event as PiSessionEvent);
		});
	}

	async listAvailableModels(): Promise<PiModelDescriptor[]> {
		return this.session.modelRegistry
			.getAvailable()
			.filter((model) => this.session.modelRegistry.hasConfiguredAuth(model))
			.map((model) => ({
				provider: model.provider,
				id: model.id,
			}));
	}

	async setActiveModel(model: PiModelDescriptor): Promise<void> {
		const resolvedModel = this.session.modelRegistry.find(model.provider, model.id);
		if (!resolvedModel || !this.session.modelRegistry.hasConfiguredAuth(resolvedModel)) {
			throw new ModelNotAvailableError(`${model.provider}/${model.id}`);
		}

		await this.session.setModel(resolvedModel);
	}

	setSessionName(name: string): void {
		this.session.setSessionName(name);
	}

	async sendUserMessage(content: string): Promise<void> {
		await this.session.sendUserMessage(content);
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}
}

function throwOnDiagnosticErrors(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length === 0) {
		return;
	}

	throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
}

function logDiagnosticWarnings(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		if (diagnostic.type === "warning") {
			console.warn(`[pi-telegram-bot] ${diagnostic.message}`);
		}
	}
}

function safeDisposeAssistantSession(session: { dispose(): void }): void {
	try {
		session.dispose();
	} catch {
		return;
	}
}
