import { basename } from "node:path";
import type { CurrentSessionModelSelection, PiModelDescriptor } from "../pi/pi-types.js";
import { formatScheduleInstant } from "../scheduler/schedule-time.js";
import type { ScheduledTaskDelayEvent, ScheduledTaskResultEvent } from "../scheduler/scheduled-task-service.js";
import type { ParsedScheduleInput, ScheduledTask } from "../scheduler/scheduled-task-types.js";
import {
	type BotStatus,
	type CurrentSessionEntry,
	type SessionCatalogEntry,
} from "../session/session-coordinator.js";
import { getTelegramHelpLines } from "./telegram-command-definitions.js";

export function formatHelpText(): string {
	return [
		"Pi Telegram bot commands:",
		...getTelegramHelpLines(),
		"",
		"Any non-command text message is sent to the selected session.",
		"If no session is selected yet, the first freeform message creates one automatically.",
	].join("\n");
}

export function formatStartText(status: BotStatus): string {
	return ["Pi Telegram bot is ready.", "", formatStatusText(status), "", formatHelpText()].join("\n");
}

export function formatStatusText(status: BotStatus): string {
	return [
		`Workspace: ${status.workspacePath}`,
		`Run state: ${status.busy ? "busy" : "idle"}`,
		`Persisted sessions: ${status.sessionCount}`,
		`Selected session: ${formatSelectedSessionSummary(status.selectedSession)}`,
	].join("\n");
}

export function formatCurrentSessionText(session: CurrentSessionEntry | undefined): string {
	if (!session) {
		return formatNoSelectedSessionText();
	}

	return [
		`Name: ${formatSessionName(session.name)}`,
		`Workspace: ${session.cwd}`,
		`Model: ${formatModel(session.activeModel)}`,
		`Messages: ${formatUserPromptCount(session.userPromptCount)}`,
		`First Message: ${formatFirstMessage(session.firstMessage)}`,
	].join("\n");
}

export function formatRenamePromptText(session: CurrentSessionEntry | SessionCatalogEntry): string {
	return [
		"Enter new name for this session",
		`Current: ${formatSessionName(session.name)}`,
		`Created Date/time: ${formatDate(session.created)}`,
	].join("\n");
}

export function formatRenameConfirmationText(name: string): string {
	return `Current session renamed to: ${name}`;
}

export function formatNoSelectedSessionText(): string {
	return "No session is selected. Use /new, /sessions, or send a freeform message to create one.";
}

export interface FormatModelSelectionTextOptions {
	pageIndex?: number;
	pageCount?: number;
}

export function formatModelSelectionText(
	selection: CurrentSessionModelSelection,
	options?: FormatModelSelectionTextOptions,
): string {
	const title =
		options?.pageCount && options.pageCount > 1
			? `Models (page ${(options.pageIndex ?? 0) + 1}/${options.pageCount}):`
			: "Models:";

	return [
		title,
		`Current: ${formatModel(selection.currentModel)}`,
		"",
		"Tap a button below to switch the current session model.",
	].join("\n");
}

export function formatNoAvailableModelsText(selection: CurrentSessionModelSelection): string {
	return ["Models:", `Current: ${formatModel(selection.currentModel)}`, "", "No auth-configured models are currently available."].join(
		"\n",
	);
}

export function formatModelSelectionChangedText(model: PiModelDescriptor): string {
	return `Current session model set to ${formatModel(model)}.`;
}

export interface FormatSessionsTextOptions {
	pageIndex?: number;
	pageCount?: number;
	pageStartIndex?: number;
}

export function formatSessionsText(sessions: SessionCatalogEntry[], options?: FormatSessionsTextOptions): string {
	if (sessions.length === 0) {
		return "No Pi sessions found for the configured workspace yet. Use /new or send a freeform message.";
	}

	const title =
		options?.pageCount && options.pageCount > 1
			? `Sessions (page ${(options.pageIndex ?? 0) + 1}/${options.pageCount}):`
			: "Sessions:";
	const pageStartIndex = options?.pageStartIndex ?? 0;
	const lines = [title];
	for (const [index, session] of sessions.entries()) {
		const marker = session.isSelected ? "*" : " ";
		const source = session.source === "persisted" ? "pending" : formatDate(session.modified);
		lines.push(
			`${marker} ${pageStartIndex + index + 1}. ${session.id.slice(0, 8)} ${session.name ?? basename(session.path)} | ${source}`,
		);
		lines.push(`   ${truncate(session.firstMessage, 100)}`);
	}

	lines.push("");
	lines.push("Tap a button below to select a session.");
	return lines.join("\n");
}

export function formatSelectionChangedText(session: SessionCatalogEntry): string {
	return `Selected session ${session.id.slice(0, 8)} (${session.name ?? basename(session.path)}).`;
}

export function formatNewSessionText(session: SessionCatalogEntry): string {
	return [
		`New Session - ${formatDate(session.created)}`,
		`Workspace: ${session.cwd}`,
		`Model: ${formatModel(session.activeModel)}`,
	].join("\n");
}

export function formatScheduleTargetPromptText(): string {
	return "Where should this scheduled prompt run?";
}

export function formatScheduleTargetGuidanceText(): string {
	return "Use the buttons to choose new session or current session, or cancel.";
}

export function formatScheduleWhenPromptText(timezone: string): string {
	return [
		"When should this run?",
		`Server local timezone: ${timezone}`,
		"Examples: in 10 minutes, tomorrow at 5am, 2026-05-01 8:30pm, every tuesday at 8pm, every 5 minutes, every hour, every month",
		"Tap cancel or send cancel to stop.",
	].join("\n");
}

export function formatScheduleConfirmationText(schedule: ParsedScheduleInput): string {
	return [
		"I understood this schedule:",
		schedule.normalizedText,
		`Next run: ${formatScheduleInstant(schedule.nextRunAt, schedule.timezone)}`,
		`Timezone: ${schedule.timezone}`,
		"Tap confirm to continue, or cancel.",
	].join("\n");
}

export function formatSchedulePromptText(): string {
	return [
		"What prompt should I send?",
		"Tap cancel or send cancel to stop.",
	].join("\n");
}

export function formatScheduleAwaitingConfirmationText(): string {
	return "Please confirm or cancel the interpreted schedule first.";
}

export function formatScheduledTaskCreatedText(task: ScheduledTask): string {
	return [
		`Scheduled task ${task.id} created.`,
		`Schedule: ${task.schedule.normalizedText}`,
		`Next run: ${formatScheduleLine(task)}`,
		`Target: ${formatScheduledTaskTarget(task.target)}`,
		`Prompt: ${truncate(task.prompt, 120)}`,
	].join("\n");
}

export function formatScheduledTasksText(tasks: ScheduledTask[]): string {
	if (tasks.length === 0) {
		return "No scheduled tasks.";
	}

	return [
		"Scheduled tasks:",
		...tasks.flatMap((task) => [
			`${formatScheduledTaskReference(task.id)} | ${formatScheduleLine(task)} | ${formatScheduledTaskTarget(task.target)}`,
			`  ${task.schedule.normalizedText}`,
			`  ${truncate(task.prompt, 120)}`,
		]),
	].join("\n");
}

export interface FormatScheduledTaskSelectionTextOptions {
	action: "unschedule" | "runscheduled";
	pageIndex?: number;
	pageCount?: number;
	pageStartIndex?: number;
}

export function formatScheduledTaskSelectionText(
	tasks: ScheduledTask[],
	options: FormatScheduledTaskSelectionTextOptions,
): string {
	if (tasks.length === 0) {
		return "No scheduled tasks.";
	}

	const actionText = options.action === "unschedule" ? "delete" : "run now";
	const title =
		options.pageCount && options.pageCount > 1
			? `Select a scheduled task to ${actionText} (page ${(options.pageIndex ?? 0) + 1}/${options.pageCount}):`
			: `Select a scheduled task to ${actionText}:`;
	const pageStartIndex = options.pageStartIndex ?? 0;
	return [
		title,
		...tasks.flatMap((task, index) => [
			`${pageStartIndex + index + 1}. ${task.id} | ${formatScheduleLine(task)}`,
			`   ${truncate(task.prompt, 100)}`,
		]),
		"",
		"Tap a button below to continue or cancel.",
	].join("\n");
}

export function formatScheduledTaskActionConfirmationText(
	task: ScheduledTask,
	action: "unschedule" | "runscheduled",
): string {
	return [
		action === "unschedule" ? "Delete this scheduled task?" : "Run this scheduled task now?",
		`Task ID: ${task.id}`,
		`Schedule: ${task.schedule.normalizedText}`,
		`Next run: ${formatScheduleLine(task)}`,
		`Target: ${formatScheduledTaskTarget(task.target)}`,
		`Prompt: ${truncate(task.prompt, 120)}`,
		"Tap confirm to continue, or cancel.",
	].join("\n");
}

export function formatScheduledTaskDeletedText(task: ScheduledTask): string {
	return `Deleted scheduled task ${formatScheduledTaskReference(task.id)}.`;
}

export function formatScheduledTaskRunQueuedText(task: ScheduledTask, delayedByBusy: boolean): string {
	return delayedByBusy
		? `Scheduled task ${formatScheduledTaskReference(task.id)} will retry at ${formatScheduleLine(task)} because a foreground run is active.`
		: `Scheduled task ${formatScheduledTaskReference(task.id)} queued to run now.`;
}

export function formatScheduledTaskDelayText(event: ScheduledTaskDelayEvent): string {
	const waitingClause =
		event.retryCount === 1
			? "A foreground run is active"
			: `Still waiting after ${event.retryCount} busy delays`;
	return `${waitingClause}. Scheduled task ${formatScheduledTaskReference(event.task.id)} will retry at ${formatScheduleInstant(event.nextRetryAt, event.task.schedule.timezone)}.`;
}

export function formatScheduledTaskResultText(event: ScheduledTaskResultEvent): string {
	if (event.result) {
		return [
			`Scheduled task ${formatScheduledTaskReference(event.task.id)} completed.`,
			`Target: ${formatScheduledTaskTarget(event.task.target)}`,
			`Session: ${formatSessionReference(event.result.sessionId)} (${event.result.sessionName ?? basename(event.result.sessionPath)})`,
			`Reply: ${truncate(event.result.assistantText || "(empty assistant reply)", 240)}`,
		].join("\n");
	}

	return [
		`Scheduled task ${formatScheduledTaskReference(event.task.id)} failed.`,
		`Target: ${formatScheduledTaskTarget(event.task.target)}`,
		`Error: ${event.errorMessage ?? "unknown error"}`,
	].join("\n");
}

function formatScheduledTaskTarget(target: ScheduledTask["target"]): string {
	if (target.type === "new_session") {
		return "new session";
	}

	return `existing session ${formatSessionReference(target.sessionId)} (${target.sessionName ?? basename(target.sessionPath)})`;
}

function formatScheduleLine(task: ScheduledTask): string {
	return formatScheduleInstant(task.nextRunAt, task.schedule.timezone);
}

function formatScheduledTaskReference(taskId: string): string {
	return taskId.slice(0, 8);
}

function formatSessionReference(sessionId: string): string {
	return formatReferencePrefix(sessionId, 8);
}

function formatReferencePrefix(value: string, prefixLength: number): string {
	if (value.length <= prefixLength) {
		return value;
	}

	let end = prefixLength;
	while (end < value.length) {
		const trailingCharacter = value[end - 1];
		if (!trailingCharacter || !isReferenceSeparator(trailingCharacter)) {
			break;
		}

		end += 1;
	}

	return value.slice(0, end);
}

function isReferenceSeparator(value: string): boolean {
	return value === "-" || value === "_" || value === ":";
}

function formatSelectedSessionSummary(session: SessionCatalogEntry | undefined): string {
	if (!session) {
		return "none";
	}

	return `${session.id.slice(0, 8)} (${session.name ?? basename(session.path)})`;
}

function formatDate(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Chicago",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(date);

	const values = Object.fromEntries(
		parts
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	) as Record<string, string>;

	return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function formatSessionName(name: string | undefined): string {
	return name ?? "(awaiting name generation)";
}

function formatModel(model: PiModelDescriptor | undefined): string {
	if (!model) {
		return "unavailable (not reported by Pi runtime)";
	}

	return `${model.provider}/${model.id}`;
}

function formatFirstMessage(firstMessage: string): string {
	return firstMessage === "(awaiting first assistant reply)"
		? "(awaiting first message)"
		: firstMessage;
}

function formatUserPromptCount(userPromptCount: number | undefined): string {
	return userPromptCount === undefined
		? "unavailable (could not read persisted user prompts)"
		: String(userPromptCount);
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 3)}...`;
}
