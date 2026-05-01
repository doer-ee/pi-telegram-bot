import { z } from "zod";
import type { PiRuntimeFactory } from "../pi/pi-types.js";
import {
	buildScheduleInputHelpText,
	createOneTimeParsedSchedule,
	createRecurringIntervalParsedSchedule,
	createRecurringWeekdayParsedSchedule,
	parseScheduleInput,
	tryParseScheduleInput,
} from "./schedule-parser.js";
import {
	formatLocalDateTime,
	getServerTimezone,
	localDateTimeToIso,
	requireScheduledTaskDate,
	WEEKDAY_NAMES,
} from "./schedule-time.js";
import type { ParsedScheduleInput, ScheduledTaskRecurringIntervalUnit } from "./scheduled-task-types.js";

const AI_SCHEDULE_TIMEOUT_MS = 15_000;
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LocalTimeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const WeekdaySchema = z.enum([
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
]);

const OneTimeAiScheduleSchema = z.object({
	kind: z.literal("one_time"),
	localDate: LocalDateSchema,
	localTime: LocalTimeSchema,
}).strict();

const WeekdayRecurringAiScheduleSchema = z.object({
	kind: z.literal("recurring"),
	rule: z.object({
		type: z.literal("weekday"),
		weekday: WeekdaySchema,
		localTime: LocalTimeSchema,
	}).strict(),
}).strict();

const ShortIntervalRecurringAiScheduleSchema = z.object({
	kind: z.literal("recurring"),
	rule: z.object({
		type: z.literal("interval"),
		interval: z.number().int().positive(),
		unit: z.enum(["minute", "hour"]),
	}).strict(),
}).strict();

const LongIntervalRecurringAiScheduleSchema = z.object({
	kind: z.literal("recurring"),
	rule: z.object({
		type: z.literal("interval"),
		interval: z.number().int().positive(),
		unit: z.enum(["day", "week", "month"]),
		localTime: LocalTimeSchema.optional(),
	}).strict(),
}).strict();

const SupportedAiScheduleResponseSchema = z.object({
	result: z.literal("supported"),
	schedule: z.union([
		OneTimeAiScheduleSchema,
		WeekdayRecurringAiScheduleSchema,
		ShortIntervalRecurringAiScheduleSchema,
		LongIntervalRecurringAiScheduleSchema,
	]),
}).strict();

const UnsupportedAiScheduleResponseSchema = z.object({
	result: z.literal("unsupported"),
	reason: z.enum(["ambiguous", "unsupported"]),
}).strict();

const AiScheduleResponseSchema = z.union([
	SupportedAiScheduleResponseSchema,
	UnsupportedAiScheduleResponseSchema,
]);

export interface ScheduleInputParser {
	parse(input: string, now?: Date, timezone?: string): Promise<ParsedScheduleInput>;
}

export interface ScheduleAiFallbackParser {
	parse(input: string, now: Date, timezone: string): Promise<ParsedScheduleInput | undefined>;
}

export function createDeterministicScheduleInputParser(): ScheduleInputParser {
	return {
		parse: async (input, now = new Date(), timezone = getServerTimezone()) => parseScheduleInput(input, now, timezone),
	};
}

export function createHybridScheduleInputParser(options?: {
	aiFallback?: ScheduleAiFallbackParser | undefined;
}): ScheduleInputParser {
	return {
		parse: async (input, now = new Date(), timezone = getServerTimezone()) => {
			const deterministic = tryParseScheduleInput(input, now, timezone);
			if (deterministic) {
				return deterministic;
			}

			const aiFallback = options?.aiFallback;
			if (!aiFallback) {
				throw new Error(buildScheduleInputHelpText(timezone));
			}

			try {
				const aiParsed = await aiFallback.parse(input, now, timezone);
				if (aiParsed) {
					return aiParsed;
				}
			} catch (error) {
				console.warn(`[pi-telegram-bot] AI schedule fallback failed: ${formatError(error)}`);
			}

			throw new Error(buildScheduleInputHelpText(timezone));
		},
	};
}

export class PiScheduleAiParser implements ScheduleAiFallbackParser {
	constructor(
		private readonly runtimeFactory: PiRuntimeFactory,
		private readonly workspacePath: string,
		private readonly timeoutMs = AI_SCHEDULE_TIMEOUT_MS,
	) {}

	async parse(input: string, now: Date, timezone: string): Promise<ParsedScheduleInput | undefined> {
		const rawResponse = await this.runtimeFactory.runBackgroundAssistantPrompt?.({
			workspacePath: this.workspacePath,
			prompt: buildAiSchedulePrompt(input, now, timezone),
			timeoutMs: this.timeoutMs,
		});
		if (!rawResponse) {
			return undefined;
		}

		const interpretation = parseAiScheduleResponse(rawResponse);
		if (interpretation.result === "unsupported") {
			return undefined;
		}

		return createParsedScheduleFromAiInterpretation(input, interpretation.schedule, now, timezone);
	}
}

function buildAiSchedulePrompt(input: string, now: Date, timezone: string): string {
	return [
		"You convert human schedule text into a strict JSON object for a local scheduler.",
		`Server local timezone: ${timezone}`,
		`Current local date/time: ${formatLocalDateTime(now, timezone)} ${timezone}`,
		`Current ISO instant: ${now.toISOString()}`,
		"Interpret only in the server local timezone.",
		"Supported schedules:",
		"- one-time local date + local time",
		"- recurring weekday at a local time",
		"- recurring interval with unit minute, hour, day, week, or month",
		"Rules:",
		"- Return JSON only. No markdown. No code fences. No prose.",
		"- Use 24-hour local times with HH:MM.",
		"- Use local dates with YYYY-MM-DD.",
		"- Weekday schedules require an explicit localTime.",
		"- One-time schedules require explicit localDate and localTime.",
		"- Minute/hour recurrences must omit localTime.",
		"- Day/week/month recurrences may omit localTime only when the user did not provide a time and the scheduler should use the current local clock time.",
		"- Unsupported or ambiguous inputs must return an unsupported result instead of guessing.",
		"Allowed JSON shapes:",
		'{"result":"supported","schedule":{"kind":"one_time","localDate":"2026-05-01","localTime":"20:30"}}',
		'{"result":"supported","schedule":{"kind":"recurring","rule":{"type":"weekday","weekday":"tuesday","localTime":"20:00"}}}',
		'{"result":"supported","schedule":{"kind":"recurring","rule":{"type":"interval","interval":5,"unit":"minute"}}}',
		'{"result":"supported","schedule":{"kind":"recurring","rule":{"type":"interval","interval":1,"unit":"month","localTime":"20:00"}}}',
		'{"result":"unsupported","reason":"ambiguous"}',
		'{"result":"unsupported","reason":"unsupported"}',
		"User schedule text:",
		input,
	].join("\n");
}

function parseAiScheduleResponse(rawResponse: string) {
	const trimmed = rawResponse.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		throw new Error("AI schedule fallback did not return a raw JSON object.");
	}

	return AiScheduleResponseSchema.parse(JSON.parse(trimmed));
}

function createParsedScheduleFromAiInterpretation(
	input: string,
	interpretation: z.infer<typeof SupportedAiScheduleResponseSchema>["schedule"],
	now: Date,
	timezone: string,
): ParsedScheduleInput {
	if (interpretation.kind === "one_time") {
		const { year, month, day } = parseLocalDate(interpretation.localDate);
		const time = parseLocalTime(interpretation.localTime);
		const runAt = localDateTimeToIso(
			{
				year,
				month,
				day,
				hour: time.hour,
				minute: time.minute,
			},
			timezone,
		);
		if (requireScheduledTaskDate(runAt).getTime() <= now.getTime()) {
			throw new Error("That one-time schedule is already in the past.");
		}

		return createOneTimeParsedSchedule({
			input,
			runAt,
			timezone,
		});
	}

	const recurringRule = interpretation.rule;
	if (recurringRule.type === "weekday") {
		const weekday = WEEKDAY_NAMES.findIndex(
			(name) => name.toLowerCase() === recurringRule.weekday,
		);
		if (weekday < 0) {
			throw new Error(`Unsupported AI weekday: ${recurringRule.weekday}`);
		}

		return createRecurringWeekdayParsedSchedule({
			input,
			now,
			timezone,
			weekday,
			time: parseLocalTime(recurringRule.localTime),
		});
	}

	const time = "localTime" in recurringRule && recurringRule.localTime
		? parseLocalTime(recurringRule.localTime)
		: undefined;
	const unit = recurringRule.unit as ScheduledTaskRecurringIntervalUnit;
	return createRecurringIntervalParsedSchedule({
		input,
		now,
		timezone,
		unit,
		interval: recurringRule.interval,
		time,
		usesInferredTimeOfDay: time === undefined && (unit === "day" || unit === "week" || unit === "month"),
	});
}

function parseLocalDate(value: string): { year: number; month: number; day: number } {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) {
		throw new Error(`Invalid AI local date: ${value}`);
	}

	return {
		year: Number.parseInt(match[1] ?? "", 10),
		month: Number.parseInt(match[2] ?? "", 10),
		day: Number.parseInt(match[3] ?? "", 10),
	};
}

function parseLocalTime(value: string): { hour: number; minute: number } {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) {
		throw new Error(`Invalid AI local time: ${value}`);
	}

	const hour = Number.parseInt(match[1] ?? "", 10);
	const minute = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
		throw new Error(`Invalid AI local time: ${value}`);
	}

	return {
		hour,
		minute,
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
