import { describe, expect, it } from "vitest";
import type { CurrentSessionModelSelection, PiModelDescriptor } from "../src/pi/pi-types.js";
import type { CurrentSessionEntry } from "../src/session/session-coordinator.js";
import {
	formatCurrentSessionText,
	formatModelSelectionChangedText,
	formatModelSelectionText,
	formatNewSessionText,
	formatNoAvailableModelsText,
	formatNoSelectedSessionText,
	formatRenamePromptText,
	formatScheduledTaskActionConfirmationText,
	formatScheduledTaskCreatedText,
	formatScheduledTaskDelayText,
	formatScheduledTaskDeletedText,
	formatScheduledTaskResultText,
	formatScheduledTaskRunQueuedText,
	formatScheduledTaskSelectionText,
	formatScheduledTasksText,
	formatSessionsText,
} from "../src/telegram/telegram-formatters.js";

describe("formatNewSessionText", () => {
	it("formats the /new reply with timestamp, workspace, and active model", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: {
				provider: "openai",
				id: "gpt-5.4",
			},
		});

		expect(formatNewSessionText(session)).toBe(
			"New Session - 2026-04-26 09:05\nWorkspace: /workspace/project\nModel: openai/gpt-5.4",
		);
	});

	it("uses an explicit unavailable marker when the runtime does not report an active model", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
		});

		expect(formatNewSessionText(session)).toBe(
			"New Session - 2026-04-26 09:05\nWorkspace: /workspace/project\nModel: unavailable (not reported by Pi runtime)",
		);
	});
});

describe("formatCurrentSessionText", () => {
	it("formats the current session summary with workspace, model, user prompt count, and first message", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: {
				provider: "openai",
				id: "gpt-5.4",
			},
			name: "Debug Telegram formatting",
			messageCount: 7,
			userPromptCount: 3,
			firstMessage: "Please help me fix Telegram output.",
		});

		expect(formatCurrentSessionText(session)).toBe(
			"Name: Debug Telegram formatting\nWorkspace: /workspace/project\nModel: openai/gpt-5.4\nMessages: 3\nFirst Message: Please help me fix Telegram output.",
		);
	});

	it("uses awaiting placeholders when the session is still brand new", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
			name: undefined,
			messageCount: 0,
			userPromptCount: 0,
			firstMessage: "(awaiting first assistant reply)",
		});

		expect(formatCurrentSessionText(session)).toBe(
			"Name: (awaiting name generation)\nWorkspace: /workspace/project\nModel: unavailable (not reported by Pi runtime)\nMessages: 0\nFirst Message: (awaiting first message)",
		);
	});

	it("uses a truthful unavailable marker when the persisted prompt count cannot be read", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
			name: "Unreadable session",
			messageCount: 9,
			userPromptCount: undefined,
			firstMessage: "Please help me fix Telegram output.",
		});

		expect(formatCurrentSessionText(session)).toBe(
			"Name: Unreadable session\nWorkspace: /workspace/project\nModel: unavailable (not reported by Pi runtime)\nMessages: unavailable (could not read persisted user prompts)\nFirst Message: Please help me fix Telegram output.",
		);
	});
});

describe("formatRenamePromptText", () => {
	it("formats the rename prompt with the current name and created timestamp in America/Chicago", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
			name: "Debug Telegram formatting",
		});

		expect(formatRenamePromptText(session)).toBe(
			"Enter new name for this session\nCurrent: Debug Telegram formatting\nCreated Date/time: 2026-04-26 09:05",
		);
	});

	it("uses the awaiting placeholder when the selected session does not have a name yet", () => {
		const session = createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
			name: undefined,
		});

		expect(formatRenamePromptText(session)).toBe(
			"Enter new name for this session\nCurrent: (awaiting name generation)\nCreated Date/time: 2026-04-26 09:05",
		);
	});
});

describe("formatSessionsText", () => {
	it("formats the compact single-page /sessions popup copy", () => {
		expect(formatSessionsText([createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
		})])).toBe("Sessions: tap one below");
	});

	it("formats the compact paginated /sessions popup copy", () => {
		expect(formatSessionsText([createSession({
			created: new Date("2026-04-26T14:05:00.000Z"),
			cwd: "/workspace/project",
			activeModel: undefined,
		})], { pageIndex: 1, pageCount: 3 })).toBe(
			"Sessions (page 2/3): tap one below",
		);
	});

	it("keeps the truthful empty state when no sessions exist yet", () => {
		expect(formatSessionsText([])).toBe(
			"No Pi sessions found for the configured workspace yet. Use /new or send a freeform message or supported upload.",
		);
	});
});

describe("model selection formatters", () => { it("formats the /model picker header with the current model and paging info", () => {
		const selection = createModelSelection({
			currentModel: {
				provider: "openai",
				id: "gpt-5.4",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5.4" },
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
			],
		});

		expect(formatModelSelectionText(selection, { pageIndex: 1, pageCount: 3 })).toBe(
			"Models (page 2/3):\nCurrent: openai/gpt-5.4\n\nTap a button below to switch the current session model.",
		);
	});

	it("formats truthful /model empty states and confirmations", () => {
		const selection = createModelSelection({ currentModel: undefined, availableModels: [] });

		expect(formatNoSelectedSessionText()).toBe(
			"No session is selected. Use /new, /sessions, or send a freeform message or supported upload to create one.",
		);
		expect(formatNoAvailableModelsText(selection)).toBe(
			"Models:\nCurrent: unavailable (not reported by Pi runtime)\n\nNo auth-configured models are currently available.",
		);
		expect(
			formatModelSelectionChangedText({
				provider: "anthropic",
				id: "claude-sonnet-4-5",
			}),
		).toBe("Current session model set to anthropic/claude-sonnet-4-5.");
	}); });

describe("scheduled task formatters", () => {
	it("formats creation, listing, deletion, delay, and run-queue messages", () => {
		const task = createScheduledTask();

		expect(formatScheduledTaskCreatedText(task)).toBe(
			"Scheduled task task-2026 created.\nSchedule: One time at 2026-05-01 3:00PM UTC\nNext run: 2026-05-01 3:00PM UTC\nTarget: new session\nPrompt: Summarize the overnight repo changes",
		);
		expect(formatScheduledTasksText([task])).toBe(
			"Scheduled tasks:\ntask-202 | 2026-05-01 3:00PM UTC | new session\n  One time at 2026-05-01 3:00PM UTC\n  Summarize the overnight repo changes",
		);
		expect(formatScheduledTaskDeletedText(task)).toBe("Deleted scheduled task task-202.");
		expect(formatScheduledTaskRunQueuedText(task, false)).toBe("Scheduled task task-202 queued to run now.");
		expect(
			formatScheduledTaskRunQueuedText(
				{ ...task, nextRunAt: "2026-05-01T15:01:00.000Z" },
				true,
			),
		).toBe(
			"Scheduled task task-202 will retry at 2026-05-01 3:01PM UTC because a foreground run is active.",
		);
		expect(
			formatScheduledTaskDelayText({
				task: { ...task, nextRunAt: "2026-05-01T15:01:00.000Z" },
				retryCount: 5,
				nextRetryAt: "2026-05-01T15:01:00.000Z",
			}),
		).toBe(
			"Still waiting after 5 busy delays. Scheduled task task-202 will retry at 2026-05-01 3:01PM UTC.",
		);
	});

	it("formats scheduled task picker and confirmation text for interactive menus", () => {
		const task = createScheduledTask();

		expect(
			formatScheduledTaskSelectionText([task], {
				action: "unschedule",
				pageIndex: 1,
				pageCount: 3,
				pageStartIndex: 5,
			}),
		).toBe(
			"Select a scheduled task to delete (page 2/3):\n6. task-2026 | 2026-05-01 3:00PM UTC\n   Summarize the overnight repo changes\n\nTap a button below to continue or cancel.",
		);
		expect(formatScheduledTaskSelectionText([], { action: "runscheduled" })).toBe("No scheduled tasks.");
		expect(formatScheduledTaskActionConfirmationText(task, "runscheduled")).toBe(
			"Run this scheduled task now?\nTask ID: task-2026\nSchedule: One time at 2026-05-01 3:00PM UTC\nNext run: 2026-05-01 3:00PM UTC\nTarget: new session\nPrompt: Summarize the overnight repo changes\nTap confirm to continue, or cancel.",
		);
	});

	it("formats concise scheduled task success and failure summaries", () => {
		const task = createScheduledTask({
			target: {
				type: "existing_session",
				sessionPath: "/workspace/existing.jsonl",
				sessionId: "session-42",
				sessionName: "Morning Review",
			},
		});

		expect(
			formatScheduledTaskResultText({
				task,
				result: {
					sessionPath: "/workspace/existing.jsonl",
					sessionId: "session-42",
					sessionName: "Morning Review",
					assistantText: "Done.",
					activeModel: undefined,
					target: task.target,
				},
			}),
		).toBe(
			"Scheduled task task-202 completed.\nTarget: existing session session-4 (Morning Review)\nSession: session-4 (Morning Review)\nReply: Done.",
		);
		expect(
			formatScheduledTaskResultText({
				task,
				errorMessage: "Pi runtime unavailable",
			}),
		).toBe(
			"Scheduled task task-202 failed.\nTarget: existing session session-4 (Morning Review)\nError: Pi runtime unavailable",
		);
	});
});

function createSession(overrides: {
	created: Date;
	cwd: string;
	activeModel: PiModelDescriptor | undefined;
	name?: string | undefined;
	messageCount?: number;
	userPromptCount?: number | undefined;
	firstMessage?: string;
}): CurrentSessionEntry {
	return {
		path: `${overrides.cwd}/.pi/session.jsonl`,
		id: "session-1",
		cwd: overrides.cwd,
		name: overrides.name,
		activeModel: overrides.activeModel,
		created: overrides.created,
		modified: overrides.created,
		messageCount: overrides.messageCount ?? 0,
		userPromptCount: overrides.userPromptCount ?? ("userPromptCount" in overrides ? undefined : overrides.messageCount ?? 0),
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: "",
		isSelected: true,
		source: "pi",
	};
}

function createScheduledTask(overrides?: Record<string, unknown>) {
	return {
		id: "task-2026",
		kind: "one_time" as const,
		prompt: "Summarize the overnight repo changes",
		createdAt: "2026-05-01T14:00:00.000Z",
		updatedAt: "2026-05-01T14:00:00.000Z",
		nextRunAt: "2026-05-01T15:00:00.000Z",
		scheduledForAt: "2026-05-01T15:00:00.000Z",
		busyRetryCount: 0,
		target: { type: "new_session" as const },
		schedule: {
			kind: "one_time" as const,
			input: "2026-05-01 3:00pm",
			normalizedText: "One time at 2026-05-01 3:00PM UTC",
			timezone: "UTC",
			runAt: "2026-05-01T15:00:00.000Z",
		},
		...overrides,
	};
}

function createModelSelection(overrides: Partial<CurrentSessionModelSelection>): CurrentSessionModelSelection {
	return {
		currentModel: overrides.currentModel,
		availableModels: overrides.availableModels ?? [],
	};
}
