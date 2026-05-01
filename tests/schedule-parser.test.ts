import { describe, expect, it } from "vitest";
import {
	finalizeParsedScheduleAtConfirmation,
	parseScheduleInput,
} from "../src/scheduler/schedule-parser.js";

describe("parseScheduleInput", () => {
	it("parses supported one-time relative, tomorrow, and absolute schedules in the given timezone", () => {
		expect(parseScheduleInput("in 10 minutes", new Date("2026-05-01T15:00:00.000Z"), "UTC")).toMatchObject({
			kind: "one_time",
			nextRunAt: "2026-05-01T15:10:00.000Z",
			normalizedText: "One time at 2026-05-01 3:10PM UTC",
		});

		expect(parseScheduleInput("tomorrow at 5am", new Date("2026-05-01T15:00:00.000Z"), "UTC")).toMatchObject({
			kind: "one_time",
			nextRunAt: "2026-05-02T05:00:00.000Z",
			normalizedText: "One time at 2026-05-02 5:00AM UTC",
		});

		expect(parseScheduleInput("2026-05-01 8:30pm", new Date("2026-04-30T15:00:00.000Z"), "UTC")).toMatchObject({
			kind: "one_time",
			nextRunAt: "2026-05-01T20:30:00.000Z",
			normalizedText: "One time at 2026-05-01 8:30PM UTC",
		});
	});

	it("parses supported weekday and interval recurring schedules", () => {
		expect(parseScheduleInput("every tuesday at 8pm", new Date("2026-05-04T12:00:00.000Z"), "UTC")).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-05T20:00:00.000Z",
			normalizedText: "Every Tuesday at 8:00pm UTC",
			schedule: {
				kind: "recurring",
				rule: {
					type: "weekday",
					weekday: 2,
					timeOfDay: "20:00",
				},
			},
		});

		expect(parseScheduleInput("every 3 days at 8pm", new Date("2026-05-01T21:00:00.000Z"), "UTC")).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-04T20:00:00.000Z",
			normalizedText: "Every 3 days at 8:00pm UTC",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "day",
					interval: 3,
					anchorAt: "2026-05-01T20:00:00.000Z",
					timeOfDay: "20:00",
				},
			},
		});
	});

	it("supports loose deterministic interval phrasing for minute, hour, and month recurrences", () => {
		expect(parseScheduleInput("every 5 minutes", new Date("2026-05-01T15:00:00.000Z"), "UTC")).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T15:05:00.000Z",
			normalizedText: "Every 5 minutes",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "minute",
					interval: 5,
					anchorAt: "2026-05-01T15:00:00.000Z",
					timeOfDay: "15:00",
				},
			},
		});

		expect(parseScheduleInput("every hour", new Date("2026-05-01T15:00:00.000Z"), "UTC")).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T16:00:00.000Z",
			normalizedText: "Every 1 hour",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "hour",
					interval: 1,
					anchorAt: "2026-05-01T15:00:00.000Z",
					timeOfDay: "15:00",
				},
			},
		});

		expect(parseScheduleInput("monthly", new Date("2026-01-31T20:15:00.000Z"), "UTC")).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-02-28T20:15:00.000Z",
			normalizedText: "Every 1 month at 8:15pm UTC",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "month",
					interval: 1,
					anchorAt: "2026-01-31T20:15:00.000Z",
					timeOfDay: "20:15",
				},
			},
		});
	});

	it("anchors monthly recurrence to the local calendar month instead of drifting by 30 days", () => {
		const parsed = parseScheduleInput("every 1 month at 8pm", new Date("2026-01-31T21:00:00.000Z"), "UTC");

		expect(parsed).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-02-28T20:00:00.000Z",
			normalizedText: "Every 1 month at 8:00pm UTC",
			schedule: {
				kind: "recurring",
				firstRunAt: "2026-02-28T20:00:00.000Z",
				rule: {
					type: "interval",
					unit: "month",
					interval: 1,
					anchorAt: "2026-01-31T20:00:00.000Z",
					timeOfDay: "20:00",
				},
			},
		});
	});

	it("re-anchors minute/hour interval recurrences from confirmation time before save", () => {
		const hourlyPreview = parseScheduleInput("every hour", new Date("2026-05-01T15:00:00.000Z"), "UTC");
		const hourlyConfirmed = finalizeParsedScheduleAtConfirmation(
			hourlyPreview,
			new Date("2026-05-01T15:10:00.000Z"),
		);
		const minutePreview = parseScheduleInput("every 5 minutes", new Date("2026-05-01T15:00:00.000Z"), "UTC");
		const minuteConfirmed = finalizeParsedScheduleAtConfirmation(
			minutePreview,
			new Date("2026-05-01T15:10:00.000Z"),
		);

		expect(hourlyConfirmed).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T16:10:00.000Z",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "hour",
					interval: 1,
					anchorAt: "2026-05-01T15:10:00.000Z",
				},
			},
		});
		expect(minuteConfirmed).toMatchObject({
			kind: "recurring",
			nextRunAt: "2026-05-01T15:15:00.000Z",
			schedule: {
				kind: "recurring",
				rule: {
					type: "interval",
					unit: "minute",
					interval: 5,
					anchorAt: "2026-05-01T15:10:00.000Z",
				},
			},
		});
	});

	it("does not shift day/week/month interval semantics when confirmation is delayed", () => {
		const dailyPreview = parseScheduleInput("every day at 8pm", new Date("2026-05-01T15:00:00.000Z"), "UTC");
		const weeklyPreview = parseScheduleInput("weekly at 8pm", new Date("2026-05-01T15:00:00.000Z"), "UTC");
		const monthlyPreview = parseScheduleInput("every month", new Date("2026-01-31T20:15:00.000Z"), "UTC");

		expect(
			finalizeParsedScheduleAtConfirmation(dailyPreview, new Date("2026-05-01T15:10:00.000Z")),
		).toEqual(dailyPreview);
		expect(
			finalizeParsedScheduleAtConfirmation(weeklyPreview, new Date("2026-05-01T15:10:00.000Z")),
		).toEqual(weeklyPreview);
		expect(
			finalizeParsedScheduleAtConfirmation(monthlyPreview, new Date("2026-01-31T20:25:00.000Z")),
		).toEqual(monthlyPreview);
	});

	it("rejects unsupported or ambiguous inputs with local-time guidance", () => {
		expect(() => parseScheduleInput("sometime soon", new Date("2026-05-01T15:00:00.000Z"), "America/Chicago")).toThrow(
			"Could not understand that schedule in the server local timezone (America/Chicago).",
		);
	});
});
