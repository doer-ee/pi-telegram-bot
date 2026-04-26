import { basename } from "node:path";
import type { PiSessionEvent, PiSessionEventListener, PiSessionPort } from "../pi/pi-types.js";
import { sanitizeSessionTitleForLog } from "./session-title-logging.js";

export interface SessionProgressUpdate {
	eventType: string;
	summary: string;
}

export type SessionProgressListener = (update: SessionProgressUpdate) => void;

export class SessionEventBinding {
	private readonly listeners = new Set<PiSessionEventListener>();
	private readonly progressListeners = new Set<SessionProgressListener>();
	private unsubscribeCurrent: (() => void) | undefined;

	rebind(session: PiSessionPort): void {
		this.unsubscribeCurrent?.();
		this.unsubscribeCurrent = session.subscribe((event) => {
			for (const listener of this.listeners) {
				listener(event);
			}

			const progressUpdate = toSessionProgressUpdate(event);
			if (!progressUpdate) {
				return;
			}

			for (const listener of this.progressListeners) {
				listener(progressUpdate);
			}
		});
	}

	addListener(listener: PiSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	addProgressListener(listener: SessionProgressListener): () => void {
		this.progressListeners.add(listener);
		return () => {
			this.progressListeners.delete(listener);
		};
	}

	dispose(): void {
		this.unsubscribeCurrent?.();
		this.unsubscribeCurrent = undefined;
		this.listeners.clear();
		this.progressListeners.clear();
	}
}

export function toSessionProgressUpdate(event: PiSessionEvent): SessionProgressUpdate | undefined {
	switch (event.type) {
		case "tool_call":
		case "tool_execution_start":
			return buildToolProgressUpdate(event.type, event.toolName, event.input ?? event.args);
		case "tool_execution_end":
			if (event.isError) {
				return {
					eventType: event.type,
					summary: buildToolFailureSummary(event.toolName),
				};
			}
			return undefined;
		case "auto_retry_start":
			return {
				eventType: event.type,
				summary: formatRetrySummary(event.attempt, event.maxAttempts),
			};
		case "compaction_start":
			return {
				eventType: event.type,
				summary: "Compacting session context",
			};
		default:
			return undefined;
	}
}

function buildToolProgressUpdate(
	eventType: string,
	toolName: string | undefined,
	rawInput: Record<string, unknown> | undefined,
): SessionProgressUpdate | undefined {
	const normalizedToolName = normalizeToolName(toolName);
	if (!normalizedToolName) {
		return undefined;
	}

	const input = isRecord(rawInput) ? rawInput : undefined;
	const skillName = extractSkillName(normalizedToolName, input);
	if (skillName) {
		return {
			eventType,
			summary: `Using skill: ${skillName}`,
		};
	}

	switch (normalizedToolName) {
		case "bash":
		case "shell":
		case "interactive_bash": {
			const command = pickFirstString(input, ["command", "tmux_command"]);
			return {
				eventType,
				summary: command ? `Running command: ${formatCommand(command)}` : "Running a command",
			};
		}
		case "read": {
			const path = pickFirstString(input, ["path", "file_path"]);
			return {
				eventType,
				summary: path ? `Reading ${formatPath(path)}` : "Reading a file",
			};
		}
		case "write":
		case "edit":
		case "apply_patch": {
			const path = pickFirstString(input, ["path", "file_path"]);
			return {
				eventType,
				summary: path ? `Updating ${formatPath(path)}` : "Updating files",
			};
		}
		case "grep": {
			return {
				eventType,
				summary: formatSearchSummary(),
			};
		}
		case "glob":
		case "find": {
			const pattern = pickFirstString(input, ["pattern"]);
			const path = pickFirstString(input, ["path"]);
			return {
				eventType,
				summary: formatFindSummary(pattern, path),
			};
		}
		case "ls":
		case "stat": {
			const path = pickFirstString(input, ["path"]);
			return {
				eventType,
				summary: path ? `Inspecting ${formatPath(path)}` : "Inspecting files",
			};
		}
		case "todowrite":
			return {
				eventType,
				summary: "Updating task list",
			};
		case "webfetch": {
			const url = pickFirstString(input, ["url"]);
			return {
				eventType,
				summary: url ? `Fetching ${formatUrl(url)}` : "Fetching web content",
			};
		}
		case "look_at": {
			const path = pickFirstString(input, ["file_path"]);
			return {
				eventType,
				summary: path ? `Analyzing ${formatPath(path)}` : "Analyzing a file",
			};
		}
		case "lsp_symbols":
		case "lsp_find_references":
		case "lsp_goto_definition":
		case "lsp_diagnostics":
		case "ast_grep_search":
		case "ast_grep_replace":
			return {
				eventType,
				summary: "Inspecting code structure",
			};
		default:
			return {
				eventType,
				summary: `Using ${formatToolLabel(normalizedToolName)}`,
			};
	}
}

function buildToolFailureSummary(toolName: string | undefined): string {
	const normalizedToolName = normalizeToolName(toolName);
	if (!normalizedToolName) {
		return "A tool reported an error";
	}

	if (normalizedToolName === "bash" || normalizedToolName === "shell" || normalizedToolName === "interactive_bash") {
		return "A command reported an error";
	}

	return `${formatToolLabel(normalizedToolName)} reported an error`;
}

function formatRetrySummary(attempt: number | undefined, maxAttempts: number | undefined): string {
	if (typeof attempt === "number" && typeof maxAttempts === "number" && maxAttempts > 0) {
		return `Retrying response (${attempt}/${maxAttempts})`;
	}

	return "Retrying response";
}

function formatSearchSummary(): string {
	return "Searching files";
}

function formatFindSummary(pattern: string | undefined, path: string | undefined): string {
	if (pattern && path) {
		return `Finding files in ${formatPath(path)}`;
	}

	if (pattern) {
		return "Finding files";
	}

	if (path) {
		return `Inspecting ${formatPath(path)}`;
	}

	return "Finding files";
}

function normalizeToolName(toolName: string | undefined): string | undefined {
	const normalizedToolName = toolName?.trim();
	return normalizedToolName ? normalizedToolName : undefined;
}

function extractSkillName(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	const location = pickFirstString(input, ["location"]);
	const explicitSkillName = pickFirstString(input, ["skillName", "skill", "name"]);
	const inferredSkillName = explicitSkillName ?? (location ? extractSkillNameFromLocation(location) : undefined);

	if (toolName.toLowerCase().includes("skill")) {
		return inferredSkillName ? sanitizeStructuredFragment(inferredSkillName, 60) : "a skill";
	}

	return inferredSkillName && location?.toLowerCase().includes("skill")
		? sanitizeStructuredFragment(inferredSkillName, 60)
		: undefined;
}

function extractSkillNameFromLocation(location: string): string | undefined {
	const normalized = location.replace(/\\/gu, "/");
	const segments = normalized.split("/").filter(Boolean);
	if (segments.length === 0) {
		return undefined;
	}

	const fileName = segments.at(-1)?.toLowerCase();
	if (fileName === "skill.md" || fileName === "skill.yaml" || fileName === "skill.yml") {
		return segments.at(-2);
	}

	const stem = basename(normalized).replace(/\.[^.]+$/u, "");
	return stem.length > 0 ? stem : undefined;
}

function pickFirstString(
	input: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!input) {
		return undefined;
	}

	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function formatCommand(command: string): string {
	return sanitizeCommandFragment(command.replace(/\s+/gu, " "), 80);
}

function formatPath(path: string): string {
	const normalized = path.replace(/\\/gu, "/").trim();
	if (normalized.length === 0) {
		return "a file";
	}

	const segments = normalized.split("/").filter(Boolean);
	const displayPath =
		normalized.startsWith("/") && segments.length > 3
			? `.../${segments.slice(-3).join("/")}`
			: segments.length > 4
				? `.../${segments.slice(-4).join("/")}`
				: normalized;

	return sanitizeStructuredFragment(displayPath, 80);
}

function formatUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return sanitizeStructuredFragment(`${parsed.host}${path}`, 80);
	} catch {
		return sanitizeStructuredFragment(url, 80);
	}
}

function formatToolLabel(toolName: string): string {
	return sanitizeStructuredFragment(toolName.replace(/[_-]+/gu, " "), 60);
}

function sanitizeCommandFragment(value: string, maxLength = 80): string {
	const sanitized = sanitizeSessionTitleForLog(value).replace(/\s+/gu, " ").trim();
	if (sanitized.length <= maxLength) {
		return sanitized;
	}

	return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sanitizeStructuredFragment(value: string, maxLength = 80): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) {
		return sanitizeStructuredContent(normalized);
	}

	const sanitized = sanitizeStructuredContent(normalized);
	if (sanitized.length <= maxLength) {
		return sanitized;
	}

	return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sanitizeStructuredContent(value: string): string {
	return value
		.split(/([\\/\s:=?&|,()[\]{}<>]+)/u)
		.map((fragment) => (isStructuredSeparator(fragment) ? fragment : sanitizeSessionTitleForLog(fragment)))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
}

function isStructuredSeparator(value: string): boolean {
	return /^[\\/\s:=?&|,()[\]{}<>]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
