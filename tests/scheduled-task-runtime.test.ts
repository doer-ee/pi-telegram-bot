import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	finalizeParsedScheduleAtConfirmation,
	parseScheduleInput,
} from "../src/scheduler/schedule-parser.js";
import { ScheduledTaskRuntime } from "../src/scheduler/scheduled-task-runtime.js";
import { FileAppStateStore } from "../src/state/file-app-state-store.js";
import { SessionCoordinator } from "../src/session/session-coordinator.js";
import type {
	PiModelDescriptor,
	PiRuntimeFactory,
	PiRuntimePort,
	PiSessionEvent,
	PiSessionEventListener,
	PiSessionPort,
	SessionTitleRefinementRequest,
	SessionInfoRecord,
} from "../src/pi/pi-types.js";

describe("ScheduledTaskRuntime", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("delays due work by exactly one minute while a foreground run is active, then retries once idle", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-01T15:00:00.000Z"));

		const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-scheduler-"));
		const workspacePath = join(tempDir, "workspace");
		const statePath = join(tempDir, "state.json");
		await mkdir(workspacePath, { recursive: true });

		let scheduler: ScheduledTaskRuntime | undefined;
		try {
			const runtimeFactory = new MockPiRuntimeFactory();
			const stateStore = new FileAppStateStore(statePath);
			const coordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);
			const delayedEvents: string[] = [];
			const completedReplies: string[] = [];
			scheduler = new ScheduledTaskRuntime(workspacePath, stateStore, coordinator, {
				onDelayed: async (event) => {
					delayedEvents.push(event.nextRetryAt);
				},
				onCompleted: async (event) => {
					if (event.result) {
						completedReplies.push(event.result.assistantText);
					}
				},
			});

			await coordinator.initialize();
			const session = await coordinator.createNewSession();
			runtimeFactory.getSession(session.path)?.pauseNextPrompt();
			const activePrompt = coordinator.sendPrompt("long running prompt");

			await scheduler.start();
			await scheduler.createTask({
				schedule: parseScheduleInput("2026-05-01 3:00pm", new Date("2026-04-30T15:00:00.000Z"), "UTC"),
				prompt: "scheduled while busy",
				target: { type: "new_session" },
			});

			await vi.runOnlyPendingTimersAsync();
			await scheduler.waitForInFlightOperations();

			expect((await scheduler.listTasks())[0]?.nextRunAt).toBe("2026-05-01T15:01:00.000Z");
			expect((await stateStore.load(workspacePath)).scheduledTasks?.[0]?.nextRunAt).toBe("2026-05-01T15:01:00.000Z");
			expect(delayedEvents).toEqual(["2026-05-01T15:01:00.000Z"]);

			await coordinator.abortActiveRun();
			await activePrompt;
			await vi.advanceTimersByTimeAsync(60_000);
			await scheduler.waitForInFlightOperations();

			expect(await scheduler.listTasks()).toEqual([]);
			expect(completedReplies).toEqual(["reply:scheduled while busy"]);
		} finally {
			await scheduler?.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("runs overdue one-time tasks once after restart", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-01T15:00:00.000Z"));

		const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-scheduler-"));
		const workspacePath = join(tempDir, "workspace");
		const statePath = join(tempDir, "state.json");
		await mkdir(workspacePath, { recursive: true });

		let restoredScheduler: ScheduledTaskRuntime | undefined;
		try {
			const runtimeFactory = new MockPiRuntimeFactory();
			const stateStore = new FileAppStateStore(statePath);
			const coordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);
			const completedReplies: string[] = [];

			await coordinator.initialize();
			const firstScheduler = new ScheduledTaskRuntime(workspacePath, stateStore, coordinator);
			await firstScheduler.start();
			await firstScheduler.createTask({
				schedule: parseScheduleInput("2026-05-01 2:59pm", new Date("2026-04-30T15:00:00.000Z"), "UTC"),
				prompt: "overdue prompt",
				target: { type: "new_session" },
			});
			await firstScheduler.stop();

			restoredScheduler = new ScheduledTaskRuntime(workspacePath, stateStore, coordinator, {
				onCompleted: async (event) => {
					if (event.result) {
						completedReplies.push(event.result.assistantText);
					}
				},
			});
			await restoredScheduler.start();
			await vi.runOnlyPendingTimersAsync();
			await restoredScheduler.waitForInFlightOperations();

			expect(completedReplies).toEqual(["reply:overdue prompt"]);
			expect(await restoredScheduler.listTasks()).toEqual([]);
		} finally {
			await restoredScheduler?.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("persists recurring monthly tasks with the next run anchored to calendar months", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-28T20:00:00.000Z"));

		const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-scheduler-"));
		const workspacePath = join(tempDir, "workspace");
		const statePath = join(tempDir, "state.json");
		await mkdir(workspacePath, { recursive: true });

		let scheduler: ScheduledTaskRuntime | undefined;
		try {
			const runtimeFactory = new MockPiRuntimeFactory();
			const stateStore = new FileAppStateStore(statePath);
			const coordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);
			scheduler = new ScheduledTaskRuntime(workspacePath, stateStore, coordinator);

			await coordinator.initialize();
			await scheduler.start();
			await scheduler.createTask({
				schedule: parseScheduleInput("every 1 month at 8pm", new Date("2026-01-31T21:00:00.000Z"), "UTC"),
				prompt: "monthly recap",
				target: { type: "new_session" },
			});

			await vi.runOnlyPendingTimersAsync();
			await scheduler.waitForInFlightOperations();

			expect((await scheduler.listTasks())[0]).toMatchObject({
				nextRunAt: "2026-03-31T20:00:00.000Z",
				scheduledForAt: "2026-03-31T20:00:00.000Z",
				schedule: {
					kind: "recurring",
					rule: {
						type: "interval",
						unit: "month",
						anchorAt: "2026-01-31T20:00:00.000Z",
					},
				},
			});
		} finally {
			await scheduler?.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves monthly calendar truth after delayed confirmation and persistence", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-28T20:15:00.000Z"));

		const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-scheduler-"));
		const workspacePath = join(tempDir, "workspace");
		const statePath = join(tempDir, "state.json");
		await mkdir(workspacePath, { recursive: true });

		let scheduler: ScheduledTaskRuntime | undefined;
		try {
			const runtimeFactory = new MockPiRuntimeFactory();
			const stateStore = new FileAppStateStore(statePath);
			const coordinator = new SessionCoordinator(workspacePath, stateStore, runtimeFactory);
			scheduler = new ScheduledTaskRuntime(workspacePath, stateStore, coordinator);

			await coordinator.initialize();
			await scheduler.start();

			const preview = parseScheduleInput("every month", new Date("2026-01-31T20:15:00.000Z"), "UTC");
			const confirmed = finalizeParsedScheduleAtConfirmation(
				preview,
				new Date("2026-01-31T20:25:00.000Z"),
			);

			await scheduler.createTask({
				schedule: confirmed,
				prompt: "monthly recap",
				target: { type: "new_session" },
			});

			expect((await stateStore.load(workspacePath)).scheduledTasks?.[0]).toMatchObject({
				nextRunAt: "2026-02-28T20:15:00.000Z",
				scheduledForAt: "2026-02-28T20:15:00.000Z",
				schedule: {
					kind: "recurring",
					rule: {
						type: "interval",
						unit: "month",
						interval: 1,
						anchorAt: "2026-01-31T20:15:00.000Z",
						timeOfDay: "20:15",
					},
				},
			});

			await vi.runOnlyPendingTimersAsync();
			await scheduler.waitForInFlightOperations();

			expect((await scheduler.listTasks())[0]).toMatchObject({
				nextRunAt: "2026-03-31T20:15:00.000Z",
				scheduledForAt: "2026-03-31T20:15:00.000Z",
				schedule: {
					kind: "recurring",
					rule: {
						type: "interval",
						unit: "month",
						anchorAt: "2026-01-31T20:15:00.000Z",
					},
				},
			});
			expect((await stateStore.load(workspacePath)).scheduledTasks?.[0]).toMatchObject({
				nextRunAt: "2026-03-31T20:15:00.000Z",
				scheduledForAt: "2026-03-31T20:15:00.000Z",
			});
		} finally {
			await scheduler?.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

class MockPiRuntimeFactory implements PiRuntimeFactory {
	private readonly sessions = new Map<string, MockPiSession>();
	private nextSessionNumber = 1;

	constructor(
		private readonly initialActiveModel?: PiModelDescriptor,
		private readonly availableModels: PiModelDescriptor[] = initialActiveModel ? [initialActiveModel] : [],
	) {}

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

	getSession(path: string): MockPiSession | undefined {
		return this.sessions.get(path);
	}

	async updateSessionName(sessionPath: string, name: string): Promise<void> {
		this.sessions.get(sessionPath)?.setSessionName(name);
	}

	async refineSessionTitle(_request: SessionTitleRefinementRequest): Promise<string | undefined> {
		return undefined;
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
			this.initialActiveModel,
			this.availableModels,
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
	readonly sessionNameUpdates: string[] = [];
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	sessionName: string | undefined;
	modified = new Date();
	private readonly listeners = new Set<PiSessionEventListener>();
	private pausedPrompt: Deferred<void> | undefined;
	private streaming = false;
	private model: PiModelDescriptor | undefined;

	constructor(
		path: string,
		cwd: string,
		sessionId: string,
		initialModel?: PiModelDescriptor,
		private readonly availableModels: PiModelDescriptor[] = initialModel ? [initialModel] : [],
	) {
		this.sessionFile = path;
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.model = initialModel;
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

	async listAvailableModels(): Promise<PiModelDescriptor[]> {
		return this.availableModels;
	}

	async setActiveModel(model: PiModelDescriptor): Promise<void> {
		this.model = model;
	}

	setSessionName(name: string): void {
		this.sessionName = name;
		this.sessionNameUpdates.push(name);
		this.modified = new Date();
	}

	async sendUserMessage(content: string): Promise<void> {
		this.streaming = true;
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
