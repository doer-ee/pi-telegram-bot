import { basename } from "node:path";
import type { BotStatus, SessionCatalogEntry } from "../session/session-coordinator.js";
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

export function formatCurrentSessionText(session: SessionCatalogEntry | undefined): string {
	if (!session) {
		return "No session is selected. Use /new, /sessions, or send a freeform message to create one.";
	}

	return [
		"Selected session:",
		`- id: ${session.id}`,
		`- name: ${session.name ?? basename(session.path)}`,
		`- path: ${session.path}`,
		`- messages: ${session.messageCount}`,
		`- first message: ${session.firstMessage}`,
	].join("\n");
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
	return `Created and selected new session ${session.id.slice(0, 8)} at ${session.path}.`;
}

function formatSelectedSessionSummary(session: SessionCatalogEntry | undefined): string {
	if (!session) {
		return "none";
	}

	return `${session.id.slice(0, 8)} (${session.name ?? basename(session.path)})`;
}

function formatDate(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 16);
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 3)}...`;
}
