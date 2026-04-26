import { describe, expect, it } from "vitest";
import type { PiModelDescriptor } from "../src/pi/pi-types.js";
import type { CurrentSessionEntry } from "../src/session/session-coordinator.js";
import { formatCurrentSessionText, formatNewSessionText } from "../src/telegram/telegram-formatters.js";

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
