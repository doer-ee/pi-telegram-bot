import { basename } from "node:path";
import type { CurrentSessionModelSelection, PiModelDescriptor } from "../pi/pi-types.js";
import type { BotStatus, CurrentSessionEntry, SessionCatalogEntry } from "../session/session-coordinator.js";
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
	lines.push("Tap a button below or use /switch <session-id-prefix-or-id>.");
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
