import type { AppStateStore } from "../state/app-state.js";
import { computeNextRunAt } from "./next-run.js";
import {
	type ScheduledPromptRunner,
	type ScheduledTaskDelayEvent,
	type ScheduledTaskResultEvent,
	type ScheduledTaskService,
} from "./scheduled-task-service.js";
import type {
	ParsedScheduleInput,
	ScheduledTask,
	ScheduledTaskTarget,
} from "./scheduled-task-types.js";
import { requireScheduledTaskDate } from "./schedule-time.js";

export interface ScheduledTaskRuntimeOptions {
	now?: () => Date;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	busyDelayMs?: number;
	busyDelayNotificationInterval?: number;
	onDelayed?: (event: ScheduledTaskDelayEvent) => void | Promise<void>;
	onCompleted?: (event: ScheduledTaskResultEvent) => void | Promise<void>;
	onFailed?: (event: ScheduledTaskResultEvent) => void | Promise<void>;
}

export class ScheduledTaskRuntime implements ScheduledTaskService {
	private static readonly DEFAULT_BUSY_DELAY_MS = 60_000;
	private static readonly DEFAULT_BUSY_DELAY_NOTIFICATION_INTERVAL = 5;

	private readonly tasksById = new Map<string, ScheduledTask>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly now: () => Date;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private readonly busyDelayMs: number;
	private readonly busyDelayNotificationInterval: number;
	private readonly onDelayed: (event: ScheduledTaskDelayEvent) => void | Promise<void>;
	private readonly onCompleted: (event: ScheduledTaskResultEvent) => void | Promise<void>;
	private readonly onFailed: (event: ScheduledTaskResultEvent) => void | Promise<void>;
	private readonly inFlightTaskOperations = new Set<Promise<void>>();
	private started = false;
	private activeTaskId: string | undefined;

	constructor(
		private readonly workspacePath: string,
		private readonly stateStore: AppStateStore,
		private readonly promptRunner: ScheduledPromptRunner,
		options?: ScheduledTaskRuntimeOptions,
	) {
		this.now = options?.now ?? (() => new Date());
		this.setTimeoutFn = options?.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options?.clearTimeoutFn ?? clearTimeout;
		this.busyDelayMs = options?.busyDelayMs ?? ScheduledTaskRuntime.DEFAULT_BUSY_DELAY_MS;
		this.busyDelayNotificationInterval =
			options?.busyDelayNotificationInterval ?? ScheduledTaskRuntime.DEFAULT_BUSY_DELAY_NOTIFICATION_INTERVAL;
		this.onDelayed = options?.onDelayed ?? (() => undefined);
		this.onCompleted = options?.onCompleted ?? (() => undefined);
		this.onFailed = options?.onFailed ?? (() => undefined);
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		this.resetRuntimeState();
		const startedAt = this.now();
		const state = await this.stateStore.load(this.workspacePath);
		for (const task of state.scheduledTasks ?? []) {
			this.tasksById.set(task.id, task);
			this.armTask(task, startedAt);
		}

		this.started = true;
	}

	async stop(): Promise<void> {
		for (const timer of this.timers.values()) {
			this.clearTimeoutFn(timer);
		}
		this.timers.clear();
		this.activeTaskId = undefined;
		this.started = false;
	}

	async waitForInFlightOperations(): Promise<void> {
		while (this.inFlightTaskOperations.size > 0) {
			await Promise.allSettled(Array.from(this.inFlightTaskOperations));
		}
	}

	async createTask(input: {
		schedule: ParsedScheduleInput;
		prompt: string;
		target: ScheduledTaskTarget;
	}): Promise<ScheduledTask> {
		const createdAt = this.now();
		const prompt = input.prompt.trim();
		if (prompt.length === 0) {
			throw new Error("Scheduled prompt text cannot be blank.");
		}

		const nowIso = createdAt.toISOString();
		const nextRunAt = requireScheduledTaskDate(input.schedule.nextRunAt).toISOString();
		const task: ScheduledTask = {
			id: createScheduledTaskId(nowIso),
			kind: input.schedule.kind,
			prompt,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt,
			scheduledForAt: nextRunAt,
			busyRetryCount: 0,
			target: input.target,
			schedule: input.schedule.schedule,
		};

		this.tasksById.set(task.id, task);
		await this.persistTasks();
		if (this.started) {
			this.armTask(task, createdAt);
		}
		return task;
	}

	async listTasks(): Promise<ScheduledTask[]> {
		return sortScheduledTasks(Array.from(this.tasksById.values()));
	}

	async deleteTaskByReference(reference: string): Promise<ScheduledTask> {
		const task = this.resolveTaskReference(reference);
		this.deleteArmedTask(task.id);
		await this.persistTasks();
		return task;
	}

	async runTaskNowByReference(reference: string): Promise<{ task: ScheduledTask; delayedByBusy: boolean }> {
		const task = this.resolveTaskReference(reference);
		const queuedAt = this.now();
		const delayedByBusy = this.promptRunner.isBusy() || this.activeTaskId !== undefined;
		const scheduledForAt = queuedAt.toISOString();
		const updatedTask: ScheduledTask = {
			...task,
			nextRunAt: new Date(queuedAt.getTime() + (delayedByBusy ? this.busyDelayMs : 0)).toISOString(),
			scheduledForAt,
			updatedAt: queuedAt.toISOString(),
			busyRetryCount: delayedByBusy ? (task.busyRetryCount ?? 0) + 1 : 0,
		};
		this.tasksById.set(updatedTask.id, updatedTask);
		await this.persistTasks();
		if (this.started) {
			this.armTask(updatedTask, queuedAt);
		}

		if (delayedByBusy && this.shouldNotifyBusyDelay(updatedTask.busyRetryCount ?? 0)) {
			await this.notifySafely("delayed", () =>
				this.onDelayed({
					task: updatedTask,
					retryCount: updatedTask.busyRetryCount ?? 0,
					nextRetryAt: updatedTask.nextRunAt,
				}),
			);
		}

		return { task: updatedTask, delayedByBusy };
	}

	private armTask(task: ScheduledTask, armedAt = this.now()): void {
		this.clearExistingTimer(task.id);
		const dueAt = requireScheduledTaskDate(task.nextRunAt);
		const delayMs = Math.max(0, dueAt.getTime() - armedAt.getTime());
		const timer = this.setTimeoutFn(() => {
			this.trackTaskOperation(task.id);
		}, delayMs);
		this.timers.set(task.id, timer);
	}

	private trackTaskOperation(taskId: string): void {
		const operation = this.handleTaskDue(taskId).catch((error) => {
			console.error(
				`[pi-telegram-bot] Scheduled task ${taskId} failed before completion handling: ${formatError(error)}`,
			);
		});
		this.inFlightTaskOperations.add(operation);
		void operation.finally(() => {
			this.inFlightTaskOperations.delete(operation);
		});
	}

	private async handleTaskDue(taskId: string): Promise<void> {
		const task = this.tasksById.get(taskId);
		if (!task) {
			return;
		}

		if (this.activeTaskId && this.activeTaskId !== taskId) {
			await this.delayTaskForBusy(task);
			return;
		}

		if (this.promptRunner.isBusy()) {
			await this.delayTaskForBusy(task);
			return;
		}

		this.activeTaskId = taskId;
		this.clearExistingTimer(taskId);
		try {
			const result = await this.promptRunner.runScheduledPrompt({
				prompt: task.prompt,
				target: task.target,
			});
			const completedAt = this.now();
			await this.completeSuccessfulTask(task, completedAt);
			await this.notifySafely("completed", () => this.onCompleted({ task, result }));
		} catch (error) {
			await this.handleTaskFailure(task, error);
		} finally {
			if (this.activeTaskId === taskId) {
				this.activeTaskId = undefined;
			}
		}
	}

	private async completeSuccessfulTask(task: ScheduledTask, completedAt: Date): Promise<void> {
		if (task.kind === "recurring") {
			const completedAtIso = completedAt.toISOString();
			const nextScheduledForAt = computeNextRunAt(task.schedule, task.scheduledForAt, completedAtIso);
			const updatedTask: ScheduledTask = {
				...task,
				updatedAt: completedAtIso,
				lastRunAt: completedAtIso,
				nextRunAt: nextScheduledForAt,
				scheduledForAt: nextScheduledForAt,
				busyRetryCount: 0,
			};
			this.tasksById.set(updatedTask.id, updatedTask);
			await this.persistTasks();
			if (this.started) {
				this.armTask(updatedTask, completedAt);
			}
			return;
		}

		this.deleteArmedTask(task.id);
		await this.persistTasks();
	}

	private async handleTaskFailure(task: ScheduledTask, error: unknown): Promise<void> {
		const failedAt = this.now();
		if (task.kind === "recurring") {
			const failedAtIso = failedAt.toISOString();
			const nextScheduledForAt = computeNextRunAt(task.schedule, task.scheduledForAt, failedAtIso);
			const updatedTask: ScheduledTask = {
				...task,
				updatedAt: failedAtIso,
				nextRunAt: nextScheduledForAt,
				scheduledForAt: nextScheduledForAt,
				busyRetryCount: 0,
			};
			this.tasksById.set(updatedTask.id, updatedTask);
			await this.persistTasks();
			if (this.started) {
				this.armTask(updatedTask, failedAt);
			}
		} else {
			this.deleteArmedTask(task.id);
			await this.persistTasks();
		}

		await this.notifySafely("failed", () =>
			this.onFailed({
				task,
				errorMessage: formatError(error),
			}),
		);
	}

	private async delayTaskForBusy(task: ScheduledTask): Promise<void> {
		const delayedAt = this.now();
		const retryCount = (task.busyRetryCount ?? 0) + 1;
		const updatedTask: ScheduledTask = {
			...task,
			nextRunAt: new Date(delayedAt.getTime() + this.busyDelayMs).toISOString(),
			updatedAt: delayedAt.toISOString(),
			busyRetryCount: retryCount,
		};
		this.tasksById.set(updatedTask.id, updatedTask);
		await this.persistTasks();
		if (this.started) {
			this.armTask(updatedTask, delayedAt);
		}
		if (this.shouldNotifyBusyDelay(retryCount)) {
			await this.notifySafely("delayed", () =>
				this.onDelayed({
					task: updatedTask,
					retryCount,
					nextRetryAt: updatedTask.nextRunAt,
				}),
			);
		}
	}

	private shouldNotifyBusyDelay(retryCount: number): boolean {
		return retryCount === 1 || retryCount % this.busyDelayNotificationInterval === 0;
	}

	private resolveTaskReference(reference: string): ScheduledTask {
		const normalizedReference = reference.trim();
		if (normalizedReference.length === 0) {
			throw new Error("Scheduled task reference cannot be blank.");
		}

		const tasks = Array.from(this.tasksById.values());
		const exactMatch = tasks.find((task) => task.id === normalizedReference);
		if (exactMatch) {
			return exactMatch;
		}

		const prefixMatches = tasks.filter((task) => task.id.startsWith(normalizedReference));
		if (prefixMatches.length === 1) {
			const [match] = prefixMatches;
			if (!match) {
				throw new Error(`Scheduled task not found: ${normalizedReference}`);
			}
			return match;
		}
		if (prefixMatches.length > 1) {
			throw new Error(
				`Scheduled task reference is ambiguous: ${normalizedReference} (${prefixMatches.map((task) => task.id.slice(0, 8)).join(", ")})`,
			);
		}

		throw new Error(`Scheduled task not found: ${normalizedReference}`);
	}

	private async persistTasks(): Promise<void> {
		await this.stateStore.saveScheduledTasks(this.workspacePath, sortScheduledTasks(Array.from(this.tasksById.values())));
	}

	private deleteArmedTask(taskId: string): ScheduledTask | undefined {
		this.clearExistingTimer(taskId);
		const task = this.tasksById.get(taskId);
		if (!task) {
			return undefined;
		}
		this.tasksById.delete(taskId);
		return task;
	}

	private clearExistingTimer(taskId: string): void {
		const timer = this.timers.get(taskId);
		if (!timer) {
			return;
		}
		this.clearTimeoutFn(timer);
		this.timers.delete(taskId);
	}

	private resetRuntimeState(): void {
		this.tasksById.clear();
		this.activeTaskId = undefined;
	}

	private async notifySafely(
		eventType: "completed" | "delayed" | "failed",
		notify: () => Promise<void> | void,
	): Promise<void> {
		try {
			await notify();
		} catch (error) {
			console.error(
				`[pi-telegram-bot] Scheduled task ${eventType} notification failed: ${formatError(error)}`,
			);
		}
	}
}

function createScheduledTaskId(nowIso: string): string {
	return `task-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortScheduledTasks(tasks: ScheduledTask[]): ScheduledTask[] {
	return [...tasks].sort((left, right) => {
		return requireScheduledTaskDate(left.nextRunAt).getTime() - requireScheduledTaskDate(right.nextRunAt).getTime();
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
