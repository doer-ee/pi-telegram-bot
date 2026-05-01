import type { PiModelDescriptor } from "../pi/pi-types.js";
import type {
	ParsedScheduleInput,
	ScheduledTask,
	ScheduledTaskTarget,
} from "./scheduled-task-types.js";

export interface ScheduledPromptRunRequest {
	prompt: string;
	target: ScheduledTaskTarget;
}

export interface ScheduledPromptRunResult {
	sessionPath: string;
	sessionId: string;
	sessionName?: string | undefined;
	assistantText: string;
	activeModel?: PiModelDescriptor | undefined;
	target: ScheduledTaskTarget;
}

export interface ScheduledTaskDelayEvent {
	task: ScheduledTask;
	retryCount: number;
	nextRetryAt: string;
}

export interface ScheduledTaskResultEvent {
	task: ScheduledTask;
	result?: ScheduledPromptRunResult | undefined;
	errorMessage?: string | undefined;
}

export interface ScheduledTaskService {
	start(): Promise<void>;
	stop(): Promise<void>;
	createTask(input: {
		schedule: ParsedScheduleInput;
		prompt: string;
		target: ScheduledTaskTarget;
	}): Promise<ScheduledTask>;
	listTasks(): Promise<ScheduledTask[]>;
	deleteTaskByReference(reference: string): Promise<ScheduledTask>;
	runTaskNowByReference(reference: string): Promise<{ task: ScheduledTask; delayedByBusy: boolean }>;
}

export interface ScheduledPromptRunner {
	isBusy(): boolean;
	runScheduledPrompt(request: ScheduledPromptRunRequest): Promise<ScheduledPromptRunResult>;
}
