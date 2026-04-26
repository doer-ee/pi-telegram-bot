import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PiModelDescriptor,
	PiRuntimeFactory,
	PiRuntimePort,
	PiSessionEvent,
	PiSessionEventListener,
	PiSessionPort,
	SessionInfoRecord,
} from "../src/pi/pi-types.js";
import {
	AmbiguousSessionReferenceError,
	BusySessionError,
	SessionNotFoundError,
} from "../src/session/session-errors.js";
import { type ActiveSessionInfo, SessionCoordinator } from "../src/session/session-coordinator.js";
import { FileAppStateStore } from "../src/state/file-app-state-store.js";

describe("SessionCoordinator", () => {
	let tempDir: string;
	let workspacePath: string;
	let statePath: string;
	let consoleInfoMock: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-"));
		workspacePath = join(tempDir, "workspace");
		statePath = join(tempDir, "state.json");
		await mkdir(workspacePath, { recursive: true });
		consoleInfoMock = vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		consoleInfoMock.mockRestore();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("#given no selected session", () => {
		it("#when creating a new session #then the selected catalog entry includes the active runtime model", async () => {
			const activeModel: PiModelDescriptor = {
				provider: "openai",
				id: "gpt-5.4",
			};
			const runtimeFactory = new MockPiRuntimeFactory(activeModel);
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			const session = await coordinator.createNewSession();

			expect(session.cwd).toBe(workspacePath);
			expect(session.activeModel).toEqual(activeModel);
			expect((await coordinator.getCurrentSession())?.activeModel).toEqual(activeModel);
		});

		it("#when sending a short freeform prompt #then it auto-creates the session and still attempts background refinement", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			const result = await coordinator.sendPrompt("hello from telegram");
			const selected = await coordinator.getCurrentSession();

			expect(result.sessionPath).toBe(selected?.path);
			expect(selected?.isSelected).toBe(true);
			expect(selected?.name).toBe("Hello from telegram");
			expect(runtimeFactory.getSession(result.sessionPath)?.messages).toEqual(["hello from telegram"]);
			expect(runtimeFactory.refineRequests).toHaveLength(1);
			expect(runtimeFactory.refineRequests[0]?.timeoutMs).toBe(15_000);
			expect(consoleInfoMock).toHaveBeenCalledWith(
				"[pi-telegram-bot] session-title heuristic=\"Hello from telegram\"",
			);
			expect(consoleInfoMock).not.toHaveBeenCalledWith(
				"[pi-telegram-bot] session-title refinement skipped final=\"Hello from telegram\"",
			);
		});

		it("#when the first prompt contains a secret-like token #then title diagnostics redact it from runtime logs", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);
			const secret = "sk-proj-AbCdEf1234567890XYZ987654321";

			await coordinator.initialize();
			await coordinator.sendPrompt(`Please rotate OPENAI_API_KEY=${secret} tonight`);

			const combinedLogs = consoleInfoMock.mock.calls.map(([line]) => String(line)).join("\n");

			expect(combinedLogs).not.toContain(secret);
			expect(combinedLogs).toContain("OPENAI_API_KEY=[secret]");
		});

		it("#when requesting the current session prompt count and the narrow lookup fails #then it degrades without throwing or guessing", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			runtimeFactory.getPersistedUserPromptCountHandler = async () => undefined;
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			const session = await coordinator.createNewSession();
			await coordinator.sendPrompt("hello from telegram");

			await expect(coordinator.getCurrentSessionWithPromptCount()).resolves.toMatchObject({
				path: session.path,
				messageCount: 1,
				userPromptCount: undefined,
			});
			expect(runtimeFactory.persistedUserPromptCountRequests).toEqual([session.path]);
		});
	});

	describe("#given a brand new named session", () => {
		it("#when the first prompt is sent after /new #then it applies a heuristic title immediately and refines once in the background", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const pendingRefinement = createDeferred<string | undefined>();
			runtimeFactory.refineSessionTitleHandler = async () => pendingRefinement.promise;
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
				{ titleRefinementTimeoutMs: 250 },
			);

			await coordinator.initialize();
			const session = await coordinator.createNewSession();
			const prompt =
				"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive";

			await coordinator.sendPrompt(prompt);
			expect((await coordinator.getCurrentSession())?.name).toBe("Debug the Telegram bot session naming after");
			expect(runtimeFactory.refineRequests).toHaveLength(1);

			pendingRefinement.resolve("Telegram naming after /new");
			await flushAsyncWork();

			expect((await coordinator.getCurrentSession())?.path).toBe(session.path);
			expect((await coordinator.getCurrentSession())?.name).toBe("Telegram naming after /new");
			expect(consoleInfoMock).toHaveBeenCalledWith(
				"[pi-telegram-bot] session-title heuristic=\"Debug the Telegram bot session naming after\"",
			);
			expect(consoleInfoMock).toHaveBeenCalledWith(
				"[pi-telegram-bot] session-title refinement accepted final=\"Telegram naming after /new\"",
			);

			await coordinator.sendPrompt("follow-up prompt");
			expect(runtimeFactory.refineRequests).toHaveLength(1);
		});

		it("#when AI refinement returns a weak title #then it keeps the heuristic title and logs the rejection", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			runtimeFactory.refineSessionTitleHandler = async () => "New chat";
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
				{ titleRefinementTimeoutMs: 250 },
			);

			await coordinator.initialize();
			await coordinator.createNewSession();
			await coordinator.sendPrompt(
				"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive",
			);
			await flushAsyncWork();

			expect((await coordinator.getCurrentSession())?.name).toBe(
				"Debug the Telegram bot session naming after",
			);
			expect(consoleInfoMock).toHaveBeenCalledWith(
				"[pi-telegram-bot] session-title refinement rejected final=\"Debug the Telegram bot session naming after\" candidate=\"New chat\"",
			);
		});

		it("#when the active session name changes or the selection changes #then observers receive the active session update", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const pendingRefinement = createDeferred<string | undefined>();
			runtimeFactory.refineSessionTitleHandler = async () => pendingRefinement.promise;
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
				{ titleRefinementTimeoutMs: 250 },
			);
			const observedSessions: ActiveSessionInfo[] = [];
			coordinator.addActiveSessionObserver({
				onActiveSessionUpdated: (session) => {
					observedSessions.push(session);
				},
			});

			await coordinator.initialize();
			const sessionA = await coordinator.createNewSession();
			await coordinator.sendPrompt(
				"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive",
			);

			pendingRefinement.resolve("Telegram naming after /new");
			await flushAsyncWork();

			const sessionB = await coordinator.createNewSession();
			await coordinator.sendPrompt("Collect a quick release checklist for the Pi Telegram bot");
			await coordinator.switchSession(sessionA.path);

			expect(observedSessions).toContainEqual({
				path: sessionA.path,
				id: sessionA.id,
				name: "Debug the Telegram bot session naming after",
			});
			expect(observedSessions).toContainEqual({
				path: sessionA.path,
				id: sessionA.id,
				name: "Telegram naming after /new",
			});
			expect(observedSessions).toContainEqual({
				path: sessionB.path,
				id: sessionB.id,
				name: "Collect a quick release checklist for the",
			});
			expect(observedSessions[observedSessions.length - 1]).toEqual({
				path: sessionA.path,
				id: sessionA.id,
				name: "Telegram naming after /new",
			});
		});

		it("#when AI refinement hangs or times out #then the first prompt still completes and the heuristic title stays in place", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			runtimeFactory.refineSessionTitleHandler = async () => createDeferred<string | undefined>().promise;
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
				{ titleRefinementTimeoutMs: 20 },
			);

			await coordinator.initialize();
			await coordinator.createNewSession();
			const prompt =
				"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive";

			const result = await coordinator.sendPrompt(prompt);
			expect(result.assistantText).toBe(`reply:${prompt}`);
			expect((await coordinator.getCurrentSession())?.name).toBe("Debug the Telegram bot session naming after");

			await waitFor(40);

			expect((await coordinator.getCurrentSession())?.name).toBe("Debug the Telegram bot session naming after");
			expect(runtimeFactory.refineRequests).toHaveLength(1);
		});
	});

	describe("#given two sessions", () => {
		it("#when switching back and forth #then prompts stay in the explicitly selected session", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();

			const sessionA = await coordinator.createNewSession();
			await coordinator.sendPrompt("prompt to A");

			const sessionB = await coordinator.createNewSession();
			await coordinator.sendPrompt("prompt to B");

			await coordinator.switchSession(sessionA.path);
			await coordinator.sendPrompt("second prompt to A");

			expect(runtimeFactory.getSession(sessionA.path)?.messages).toEqual(["prompt to A", "second prompt to A"]);
			expect(runtimeFactory.getSession(sessionB.path)?.messages).toEqual(["prompt to B"]);
		});
	});

	describe("#given an active run", () => {
		it("#when switching sessions or sending another prompt #then it rejects with the busy guard", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			const sessionA = await coordinator.createNewSession();
			const sessionB = await coordinator.createNewSession();
			await coordinator.switchSession(sessionA.path);
			runtimeFactory.getSession(sessionA.path)?.pauseNextPrompt();

			const activePrompt = coordinator.sendPrompt("long running prompt");

			await expect(coordinator.sendPrompt("second prompt")).rejects.toBeInstanceOf(BusySessionError);
			await expect(coordinator.createNewSession()).rejects.toBeInstanceOf(BusySessionError);
			await expect(coordinator.switchSession(sessionB.path)).rejects.toBeInstanceOf(BusySessionError);

			const aborted = await coordinator.abortActiveRun();
			expect(aborted).toBe(true);
			await activePrompt;
		});
	});

	describe("#given runtime progress events", () => {
		it("#when tool and skill events arrive #then the observer receives concise safe progress summaries", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);
			const secretToken = "sk-proj-AbCdEf1234567890XYZ987654321";

			await coordinator.initialize();
			const session = await coordinator.createNewSession();
			const runtimeSession = runtimeFactory.getSession(session.path);
			runtimeSession?.queuePromptEvents([
				{
					type: "tool_execution_start",
					toolName: "grep",
					args: {
						include: `src/**/*OPENAI_API_KEY=${secretToken}*.ts`,
						pattern: `Authorization: Bearer ${secretToken}`,
					},
				},
				{
					type: "tool_execution_start",
					toolName: "glob",
					args: {
						pattern: `**/*github_pat_abcdefghijklmnopqrstuvwxyz1234567890.md`,
					},
				},
				{
					type: "tool_call",
					toolName: "skill",
					input: {
						name: "listing-agent-research",
						location: "/Users/jacobhere/.config/opencode/skills/listing-agent-research/SKILL.md",
						raw: { noisy: true },
					},
				},
				{
					type: "tool_execution_start",
					toolName: "read",
					args: {
						path: "/workspace/src/session/session-coordinator.ts",
						offset: 1,
						payload: { dump: true },
					},
				},
				{
					type: "tool_execution_start",
					toolName: "bash",
					args: {
						command: `OPENAI_API_KEY=${secretToken} npm test -- --runInBand`,
						timeout: 120,
						payload: { dump: "too noisy" },
					},
				},
				{
					type: "tool_execution_end",
					toolName: "bash",
					isError: true,
					result: {
						stdout: "large output",
						stderr: "more output",
					},
				},
			]);

			const progressSummaries: string[] = [];
			const result = await coordinator.sendPrompt("show me progress", {
				onProgress: (update) => {
					progressSummaries.push(update.summary);
				},
			});

			expect(result.assistantText).toBe("reply:show me progress");
			expect(progressSummaries).toEqual([
				"Searching files",
				"Finding files",
				"Using skill: listing-agent-research",
				"Reading .../src/session/session-coordinator.ts",
				"Running command: OPENAI_API_KEY=[secret] npm test -- --runInBand",
				"A command reported an error",
			]);

			const combinedProgress = progressSummaries.join("\n");
			expect(combinedProgress).not.toContain(secretToken);
			expect(combinedProgress).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz1234567890");
			expect(combinedProgress).not.toContain("Authorization:");
			expect(combinedProgress).not.toContain("stdout");
			expect(combinedProgress).not.toContain("stderr");
			expect(combinedProgress).not.toContain("payload");
			expect(combinedProgress).not.toContain("raw");
		});
	});

	describe("#given persisted selected-session state", () => {
		it("#when the coordinator restarts after switching among sessions #then it restores the latest selected session", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const stateStore = new FileAppStateStore(statePath);
			const firstCoordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);

			await firstCoordinator.initialize();
			const sessionA = await firstCoordinator.createNewSession();
			await firstCoordinator.sendPrompt("before restart A");

			const sessionB = await firstCoordinator.createNewSession();
			await firstCoordinator.sendPrompt("before restart B");

			await firstCoordinator.switchSession(sessionA.path);
			await firstCoordinator.sendPrompt("second prompt A");
			await firstCoordinator.switchSession(sessionB.path);
			await firstCoordinator.dispose();

			const secondCoordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);
			await secondCoordinator.initialize();

			expect((await secondCoordinator.getCurrentSession())?.path).toBe(sessionB.path);

			await secondCoordinator.sendPrompt("after restart B");
			expect(runtimeFactory.getSession(sessionA.path)?.messages).toEqual(["before restart A", "second prompt A"]);
			expect(runtimeFactory.getSession(sessionB.path)?.messages).toEqual([
				"before restart B",
				"after restart B",
			]);
		});
	});

	describe("#given explicit session references", () => {
		it("#when switching by exact id or unique prefix #then it resolves deterministically", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			const sessionA = await coordinator.createNewSession();
			const sessionB = await coordinator.createNewSession();

			const switchedByExactId = await coordinator.switchSessionByReference(sessionA.id);
			expect(switchedByExactId.path).toBe(sessionA.path);

			const switchedByPrefix = await coordinator.switchSessionByReference(sessionB.id.slice(0, 2));
			expect(switchedByPrefix.path).toBe(sessionB.path);
		});

		it("#when switching by an ambiguous or missing reference #then it rejects clearly", async () => {
			const runtimeFactory = new MockPiRuntimeFactory();
			const coordinator = new SessionCoordinator(
				workspacePath,
				new FileAppStateStore(statePath),
				runtimeFactory,
			);

			await coordinator.initialize();
			await coordinator.createNewSession();
			await coordinator.createNewSession();

			await expect(coordinator.switchSessionByReference("s")).rejects.toBeInstanceOf(
				AmbiguousSessionReferenceError,
			);
			await expect(coordinator.switchSessionByReference("missing")).rejects.toBeInstanceOf(SessionNotFoundError);
		});
	});
});

class MockPiRuntimeFactory implements PiRuntimeFactory {
	private readonly sessions = new Map<string, MockPiSession>();
	private nextSessionNumber = 1;

	constructor(private readonly activeModel?: PiModelDescriptor) {}

	readonly refineRequests: Array<{
		workspacePath: string;
		prompt: string;
		heuristicTitle: string;
		timeoutMs: number;
	}> = [];
	readonly persistedUserPromptCountRequests: string[] = [];
	refineSessionTitleHandler: ((request: {
		workspacePath: string;
		prompt: string;
		heuristicTitle: string;
		timeoutMs: number;
	}) => Promise<string | undefined>) | undefined;
	getPersistedUserPromptCountHandler: ((sessionPath: string) => Promise<number | undefined>) | undefined;

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
		this.persistedUserPromptCountRequests.push(sessionPath);
		if (this.getPersistedUserPromptCountHandler) {
			return this.getPersistedUserPromptCountHandler(sessionPath);
		}

		return this.sessions.get(sessionPath)?.messages.length ?? 0;
	}

	getSession(path: string): MockPiSession | undefined {
		return this.sessions.get(path);
	}

	async updateSessionName(sessionPath: string, name: string): Promise<void> {
		const session = this.sessions.get(sessionPath);
		if (!session) {
			throw new Error(`Unknown session ${sessionPath}`);
		}
		session.setSessionName(name);
	}

	async refineSessionTitle(request: {
		workspacePath: string;
		prompt: string;
		heuristicTitle: string;
		timeoutMs: number;
	}): Promise<string | undefined> {
		this.refineRequests.push(request);
		return this.refineSessionTitleHandler ? this.refineSessionTitleHandler(request) : undefined;
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

		const session = new MockPiSession(
			path,
			workspacePath,
			`s${this.nextSessionNumber}-session`,
			this.activeModel,
		);
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
	private pausedPrompt: Deferred<void> | undefined;
	private streaming = false;

	constructor(path: string, cwd: string, sessionId: string, private readonly model?: PiModelDescriptor) {
		this.sessionFile = path;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	get activeModel(): PiModelDescriptor | undefined {
		return this.model;
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

		if (this.pausedPrompt) {
			await this.pausedPrompt.promise;
		}

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
		this.resumePausedPrompt();
	}

	pauseNextPrompt(): void {
		this.pausedPrompt = createDeferred<void>();
	}

	queuePromptEvents(events: PiSessionEvent[]): void {
		this.queuedPromptEvents.push(...events);
	}

	resumePausedPrompt(): void {
		this.pausedPrompt?.resolve();
		this.pausedPrompt = undefined;
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

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
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

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitFor(timeoutMs: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, timeoutMs);
	});
}
