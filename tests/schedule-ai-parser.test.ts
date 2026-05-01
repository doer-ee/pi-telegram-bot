import { describe, expect, it, vi } from "vitest";
import type {
	BackgroundAssistantPromptRequest,
	PiRuntimeFactory,
	SessionTitleRefinementRequest,
} from "../src/pi/pi-types.js";
import {
	createHybridScheduleInputParser,
	PiScheduleAiParser,
} from "../src/scheduler/schedule-ai-parser.js";

describe("createHybridScheduleInputParser", () => {
	it("keeps deterministic parsing as the primary path", async () => {
		const aiFallback = {
			parse: vi.fn(async () => {
				throw new Error("AI fallback should not be called for deterministic input.");
			}),
		};
		const parser = createHybridScheduleInputParser({ aiFallback });

		const parsed = await parser.parse("every hour", new Date("2026-05-01T15:00:00.000Z"), "UTC");

		expect(aiFallback.parse).not.toHaveBeenCalled();
		expect(parsed).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T16:00:00.000Z",
			normalizedText: "Every 1 hour",
		});
	});

	it("uses validated AI fallback only when deterministic parsing cannot interpret the input", async () => {
		const requests: BackgroundAssistantPromptRequest[] = [];
		const runtimeFactory = createRuntimeFactoryStub(
			requests,
			'{"result":"supported","schedule":{"kind":"recurring","rule":{"type":"interval","interval":5,"unit":"minute"}}}',
		);
		const parser = createHybridScheduleInputParser({
			aiFallback: new PiScheduleAiParser(runtimeFactory, "/workspace"),
		});

		const parsed = await parser.parse("every five minutes", new Date("2026-05-01T15:00:00.000Z"), "UTC");

		expect(requests).toHaveLength(1);
		expect(parsed).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T15:05:00.000Z",
			normalizedText: "Every 5 minutes",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "minute",
					interval: 5,
				},
			},
		});
	});

	it("rejects AI fallback responses that are not strict raw structured data", async () => {
		const parser = createHybridScheduleInputParser({
			aiFallback: new PiScheduleAiParser(
				createRuntimeFactoryStub(
					[],
					'Here is the JSON: {"result":"supported","schedule":{"kind":"recurring","rule":{"type":"interval","interval":5,"unit":"minute"}}}',
				),
				"/workspace",
			),
		});

		await expect(
			parser.parse("every five minutes", new Date("2026-05-01T15:00:00.000Z"), "UTC"),
		).rejects.toThrow("Could not understand that schedule in the server local timezone (UTC).");
	});
});

function createRuntimeFactoryStub(
	requests: BackgroundAssistantPromptRequest[],
	response: string | undefined,
): PiRuntimeFactory {
	return {
		createRuntime: async (_options: { workspacePath: string; selectedSessionPath?: string }) => {
			throw new Error("Unexpected createRuntime call in schedule AI parser test.");
		},
		listSessions: async (_workspacePath: string) => {
			throw new Error("Unexpected listSessions call in schedule AI parser test.");
		},
		getPersistedUserPromptCount: async (_sessionPath: string) => {
			throw new Error("Unexpected getPersistedUserPromptCount call in schedule AI parser test.");
		},
		updateSessionName: async (_sessionPath: string, _name: string) => {
			throw new Error("Unexpected updateSessionName call in schedule AI parser test.");
		},
		refineSessionTitle: async (_request: SessionTitleRefinementRequest) => {
			throw new Error("Unexpected refineSessionTitle call in schedule AI parser test.");
		},
		runBackgroundAssistantPrompt: async (request: BackgroundAssistantPromptRequest) => {
			requests.push(request);
			return response;
		},
	};
}
