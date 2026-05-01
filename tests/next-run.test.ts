import { describe, expect, it } from "vitest";
import { computeNextRunAt } from "../src/scheduler/next-run.js";
import type { RecurringScheduleDefinition } from "../src/scheduler/scheduled-task-types.js";

describe("computeNextRunAt", () => {
	it("keeps monthly recurrence anchored to the original calendar day when later months are short", () => {
		const schedule: RecurringScheduleDefinition = {
			kind: "recurring",
			input: "every 1 month at 8pm",
			normalizedText: "Every 1 month at 8:00pm UTC",
			timezone: "UTC",
			firstRunAt: "2026-02-28T20:00:00.000Z",
			rule: {
				type: "interval",
				unit: "month",
				interval: 1,
				anchorAt: "2026-01-31T20:00:00.000Z",
				timeOfDay: "20:00",
			},
		};

		expect(computeNextRunAt(schedule, "2026-02-28T20:00:00.000Z")).toBe("2026-03-31T20:00:00.000Z");
		expect(computeNextRunAt(schedule, "2026-03-31T20:00:00.000Z")).toBe("2026-04-30T20:00:00.000Z");
	});

	it("skips missed recurring backlog and returns the first future occurrence after a late run", () => {
		const schedule: RecurringScheduleDefinition = {
			kind: "recurring",
			input: "every tuesday at 8pm",
			normalizedText: "Every Tuesday at 8:00pm UTC",
			timezone: "UTC",
			firstRunAt: "2026-05-05T20:00:00.000Z",
			rule: {
				type: "weekday",
				weekday: 2,
				timeOfDay: "20:00",
			},
		};

		expect(
			computeNextRunAt(schedule, "2026-05-05T20:00:00.000Z", "2026-05-20T21:00:00.000Z"),
		).toBe("2026-05-26T20:00:00.000Z");
	});

	it("advances minute and hour recurrences by fixed anchored intervals", () => {
		const schedule: RecurringScheduleDefinition = {
			kind: "recurring",
			input: "every 5 minutes",
			normalizedText: "Every 5 minutes",
			timezone: "UTC",
			firstRunAt: "2026-05-01T15:05:00.000Z",
			rule: {
				type: "interval",
				unit: "minute",
				interval: 5,
				anchorAt: "2026-05-01T15:00:00.000Z",
				timeOfDay: "15:00",
			},
		};

		expect(computeNextRunAt(schedule, "2026-05-01T15:05:00.000Z")).toBe("2026-05-01T15:10:00.000Z");
		expect(
			computeNextRunAt(schedule, "2026-05-01T15:05:00.000Z", "2026-05-01T15:16:00.000Z"),
		).toBe("2026-05-01T15:20:00.000Z");
	});
});
