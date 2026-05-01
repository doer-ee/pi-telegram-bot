import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ScheduledTask } from "../scheduler/scheduled-task-types.js";
import {
	type AppState,
	type AppStateStore,
	createEmptyAppState,
	type StoredBotOwnedSessionPin,
	type StoredRecentModel,
	type StoredSelectedSession,
} from "./app-state.js";

const StoredSelectedSessionSchema = z.object({
	path: z.string().min(1),
	sessionId: z.string().min(1),
	selectedAt: z.string().min(1),
});

const StoredBotOwnedSessionPinSchema = z.object({
	chatId: z.number().int(),
	messageId: z.number().int().positive(),
	sessionPath: z.string().min(1),
	text: z.string().min(1),
});

const StoredRecentModelSchema = z.object({
	provider: z.string().min(1),
	id: z.string().min(1),
});

const ScheduledTaskTargetSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("new_session"),
	}),
	z.object({
		type: z.literal("existing_session"),
		sessionPath: z.string().min(1),
		sessionId: z.string().min(1),
		sessionName: z.string().min(1).optional(),
	}),
]);

const OneTimeScheduleDefinitionSchema = z.object({
	kind: z.literal("one_time"),
	input: z.string().min(1),
	normalizedText: z.string().min(1),
	timezone: z.string().min(1),
	runAt: z.string().min(1),
});

const ScheduledTaskRecurringWeekdayRuleSchema = z.object({
	type: z.literal("weekday"),
	weekday: z.number().int().min(0).max(6),
	timeOfDay: z.string().min(1),
});

const ScheduledTaskRecurringIntervalRuleSchema = z.object({
	type: z.literal("interval"),
	unit: z.enum(["minute", "hour", "day", "week", "month"]),
	interval: z.number().int().positive(),
	anchorAt: z.string().min(1),
	timeOfDay: z.string().min(1),
});

const RecurringScheduleDefinitionSchema = z.object({
	kind: z.literal("recurring"),
	input: z.string().min(1),
	normalizedText: z.string().min(1),
	timezone: z.string().min(1),
	firstRunAt: z.string().min(1),
	rule: z.discriminatedUnion("type", [
		ScheduledTaskRecurringWeekdayRuleSchema,
		ScheduledTaskRecurringIntervalRuleSchema,
	]),
});

const ScheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
	OneTimeScheduleDefinitionSchema,
	RecurringScheduleDefinitionSchema,
]);

const ScheduledTaskSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["one_time", "recurring"]),
	prompt: z.string().min(1),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	nextRunAt: z.string().min(1),
	scheduledForAt: z.string().min(1),
	lastRunAt: z.string().min(1).optional(),
	busyRetryCount: z.number().int().min(0).optional(),
	target: ScheduledTaskTargetSchema,
	schedule: ScheduledTaskScheduleSchema,
});

const LegacyScheduledTaskSchema = z.object({
	id: z.string().min(1),
	kind: z.literal("one_time"),
	prompt: z.string().min(1),
	dueAt: z.string().min(1),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	busyRetryCount: z.number().int().min(0).optional(),
	target: ScheduledTaskTargetSchema,
});

const AppStateSchema = z.object({
	version: z.literal(2),
	workspacePath: z.string().min(1),
	selectedSession: StoredSelectedSessionSchema.optional(),
	botOwnedSessionPin: StoredBotOwnedSessionPinSchema.optional(),
	modelRecency: z.array(StoredRecentModelSchema).optional(),
	scheduledTasks: z.array(ScheduledTaskSchema).optional(),
});

const LegacyAppStateSchema = z.object({
	version: z.literal(1),
	workspacePath: z.string().min(1),
	selectedSession: StoredSelectedSessionSchema.optional(),
	botOwnedSessionPin: StoredBotOwnedSessionPinSchema.optional(),
	modelRecency: z.array(StoredRecentModelSchema).optional(),
	scheduledTasks: z.array(LegacyScheduledTaskSchema).optional(),
});

const AppStateDiskSchema = z.union([AppStateSchema, LegacyAppStateSchema]);

export class FileAppStateStore implements AppStateStore {
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(private readonly statePath: string) {}

	async load(workspacePath: string): Promise<AppState> {
		try {
			const content = await readFile(this.statePath, "utf8");
			const parsed = AppStateDiskSchema.parse(JSON.parse(content));
			if (parsed.workspacePath !== workspacePath) {
				return createEmptyAppState(workspacePath);
			}
			return migrateAppState(parsed);
		} catch (error) {
			if (isMissingFileError(error)) {
				return createEmptyAppState(workspacePath);
			}
			throw new Error(`Failed to load app state from ${this.statePath}: ${formatError(error)}`);
		}
	}

	async saveSelectedSession(workspacePath: string, selectedSession: StoredSelectedSession): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			selectedSession,
		}));
	}

	async clearSelectedSession(workspacePath: string): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			selectedSession: undefined,
		}));
	}

	async saveBotOwnedSessionPin(workspacePath: string, botOwnedSessionPin: StoredBotOwnedSessionPin): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			botOwnedSessionPin,
		}));
	}

	async clearBotOwnedSessionPin(workspacePath: string): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			botOwnedSessionPin: undefined,
		}));
	}

	async saveModelRecency(workspacePath: string, modelRecency: StoredRecentModel[]): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			modelRecency,
		}));
	}

	async saveScheduledTasks(workspacePath: string, scheduledTasks: ScheduledTask[]): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			scheduledTasks,
		}));
	}

	private async writeState(state: AppState): Promise<void> {
		const validated = AppStateSchema.parse(state);
		const tempPath = `${this.statePath}.tmp`;
		await mkdir(dirname(this.statePath), { recursive: true });
		await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await rename(tempPath, this.statePath);
	}

	private async updateState(
		workspacePath: string,
		update: (state: AppState) => AppState,
	): Promise<void> {
		const nextWrite = this.pendingWrite.catch(() => undefined).then(async () => {
			const currentState = await this.load(workspacePath);
			const nextState = update(currentState);
			await this.writeState(nextState);
		});

		this.pendingWrite = nextWrite;
		await nextWrite;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function formatError(error: unknown): string {
	if (error instanceof z.ZodError) {
		return error.issues.map((issue) => issue.message).join(", ");
	}
	return error instanceof Error ? error.message : String(error);
}

function migrateAppState(state: z.infer<typeof AppStateDiskSchema>): AppState {
	if (state.version === 2) {
		return state;
	}

	return {
		version: 2,
		workspacePath: state.workspacePath,
		selectedSession: state.selectedSession,
		botOwnedSessionPin: state.botOwnedSessionPin,
		modelRecency: state.modelRecency,
		scheduledTasks: state.scheduledTasks?.map((task) => ({
			id: task.id,
			kind: "one_time" as const,
			prompt: task.prompt,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			nextRunAt: task.dueAt,
			scheduledForAt: task.dueAt,
			busyRetryCount: task.busyRetryCount,
			target: task.target,
			schedule: {
				kind: "one_time" as const,
				input: task.dueAt,
				normalizedText: task.dueAt,
				timezone: "UTC",
				runAt: task.dueAt,
			},
		})),
	};
}
