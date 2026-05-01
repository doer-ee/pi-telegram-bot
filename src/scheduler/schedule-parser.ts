import { computeFirstIntervalRunAt, computeFirstWeekdayRunAt } from "./next-run.js";
import {
	getLocalDateTimeParts,
	formatScheduleInstant,
	formatTimeOfDay,
	getServerTimezone,
	localDateTimeToIso,
	parseTimeOfDayValue,
	requireScheduledTaskDate,
	WEEKDAY_NAMES,
} from "./schedule-time.js";
import type {
	ParsedScheduleInput,
	ParsedScheduleResolutionMetadata,
	ScheduledTaskRecurringIntervalRule,
	ScheduledTaskRecurringIntervalUnit,
} from "./scheduled-task-types.js";

interface TimeValue {
	hour: number;
	minute: number;
}

export function parseScheduleInput(
	input: string,
	now = new Date(),
	timezone = getServerTimezone(),
): ParsedScheduleInput {
	const parsed = tryParseScheduleInput(input, now, timezone);
	if (parsed) {
		return parsed;
	}

	throw new Error(buildScheduleInputHelpText(timezone));
}

export function tryParseScheduleInput(
	input: string,
	now = new Date(),
	timezone = getServerTimezone(),
): ParsedScheduleInput | undefined {
	const trimmedInput = input.trim();
	if (trimmedInput.length === 0) {
		throw new Error(buildScheduleInputHelpText(timezone));
	}

	return (
		parseRelativeSchedule(trimmedInput, now, timezone) ??
		parseTomorrowSchedule(trimmedInput, now, timezone) ??
		parseRecurringWeekdaySchedule(trimmedInput, now, timezone) ??
		parseRecurringIntervalSchedule(trimmedInput, now, timezone) ??
		parseAbsoluteSchedule(trimmedInput, now, timezone)
	);
}

export function finalizeParsedScheduleAtConfirmation(
	parsedSchedule: ParsedScheduleInput,
	confirmedAt = new Date(),
): ParsedScheduleInput {
	if (
		!parsedSchedule.resolution?.anchorFromConfirmation ||
		parsedSchedule.kind !== "recurring" ||
		parsedSchedule.schedule.kind !== "recurring" ||
		parsedSchedule.schedule.rule.type !== "interval"
	) {
		return parsedSchedule;
	}

	const time = resolveConfirmationTimeValue(
		parsedSchedule.schedule.rule,
		parsedSchedule.resolution,
	);
	const finalized = createRecurringIntervalParsedSchedule({
		input: parsedSchedule.schedule.input,
		now: confirmedAt,
		timezone: parsedSchedule.timezone,
		unit: parsedSchedule.schedule.rule.unit,
		interval: parsedSchedule.schedule.rule.interval,
		time,
		usesInferredTimeOfDay: parsedSchedule.resolution.usesInferredTimeOfDay ?? false,
	});

	return {
		...finalized,
		resolution: undefined,
	};
}

export function doesParsedScheduleRequireConfirmationRefresh(
	previewSchedule: ParsedScheduleInput,
	confirmedAt = new Date(),
): { refreshedSchedule: ParsedScheduleInput; changed: boolean } {
	const refreshedSchedule = finalizeParsedScheduleAtConfirmation(previewSchedule, confirmedAt);
	return {
		refreshedSchedule,
		changed: !areParsedSchedulesEquivalent(previewSchedule, refreshedSchedule),
	};
}

export function createOneTimeParsedSchedule(options: {
	input: string;
	runAt: string;
	timezone: string;
}): ParsedScheduleInput {
	const normalizedText = `One time at ${formatScheduleInstant(options.runAt, options.timezone)}`;
	return {
		kind: "one_time",
		nextRunAt: options.runAt,
		timezone: options.timezone,
		normalizedText,
		schedule: {
			kind: "one_time",
			input: options.input,
			normalizedText,
			timezone: options.timezone,
			runAt: options.runAt,
		},
	};
}

export function createRecurringWeekdayParsedSchedule(options: {
	input: string;
	now: Date;
	timezone: string;
	weekday: number;
	time: TimeValue;
}): ParsedScheduleInput {
	const nextRunAt = computeFirstWeekdayRunAt(
		options.now,
		options.timezone,
		options.weekday,
		options.time.hour,
		options.time.minute,
	);
	const normalizedText = `Every ${WEEKDAY_NAMES[options.weekday] ?? "weekday"} at ${formatTimeOfDay(options.time.hour, options.time.minute)} ${options.timezone}`;
	return {
		kind: "recurring",
		nextRunAt,
		timezone: options.timezone,
		normalizedText,
		schedule: {
			kind: "recurring",
			input: options.input,
			normalizedText,
			timezone: options.timezone,
			firstRunAt: nextRunAt,
			rule: {
				type: "weekday",
				weekday: options.weekday,
				timeOfDay: toTimeOfDayValue(options.time),
			},
		},
	};
}

export function createRecurringIntervalParsedSchedule(options: {
	input: string;
	now: Date;
	timezone: string;
	unit: ScheduledTaskRecurringIntervalUnit;
	interval: number;
	time?: TimeValue | undefined;
	usesInferredTimeOfDay?: boolean | undefined;
}): ParsedScheduleInput {
	if (!Number.isFinite(options.interval) || options.interval <= 0) {
		throw new Error("Recurring interval must be a positive whole number.");
	}

	const { anchorAt, firstRunAt, timeOfDay } = computeFirstIntervalRunAt(
		options.now,
		options.timezone,
		options.unit,
		options.interval,
		options.time,
	);
	const normalizedText = formatRecurringIntervalText(
		options.interval,
		options.unit,
		options.timezone,
		timeOfDay,
	);

	return {
		kind: "recurring",
		nextRunAt: firstRunAt,
		timezone: options.timezone,
		normalizedText,
		...(shouldAnchorRecurringIntervalFromConfirmation(options.unit)
			? {
				resolution: {
					anchorFromConfirmation: true,
					usesInferredTimeOfDay: options.usesInferredTimeOfDay,
				},
			}
			: {}),
		schedule: {
			kind: "recurring",
			input: options.input,
			normalizedText,
			timezone: options.timezone,
			firstRunAt: firstRunAt,
			rule: {
				type: "interval",
				unit: options.unit,
				interval: options.interval,
				anchorAt,
				timeOfDay,
			},
		},
	};
}

export function buildScheduleInputHelpText(timezone = getServerTimezone()): string {
	return [
		`Could not understand that schedule in the server local timezone (${timezone}).`,
		"Try one of:",
		"- in 10 minutes",
		"- tomorrow at 5am",
		"- 2026-05-01 8:30pm",
		"- every tuesday at 8pm",
		"- every 5 minutes",
		"- every hour",
		"- every month",
	].join("\n");
}

function parseRelativeSchedule(input: string, now: Date, timezone: string): ParsedScheduleInput | undefined {
	const match = /^in\s+(\d+)\s+(minute|minutes|min|mins|hour|hours|day|days)$/i.exec(input);
	if (!match) {
		return undefined;
	}

	const amount = Number.parseInt(match[1] ?? "", 10);
	const unit = (match[2] ?? "").toLowerCase();
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error("Schedule amount must be a positive whole number.");
	}

	const multiplierMs = unit.startsWith("min") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
	const runAt = new Date(now.getTime() + amount * multiplierMs).toISOString();
	return createOneTimeParsedSchedule({
		input,
		runAt,
		timezone,
	});
}

function parseTomorrowSchedule(input: string, now: Date, timezone: string): ParsedScheduleInput | undefined {
	const match = /^tomorrow\s+at\s+(.+)$/i.exec(input);
	if (!match) {
		return undefined;
	}

	const time = parseTimeValue(match[1] ?? "");
	const localNow = getLocalDateTimeParts(now, timezone);
	const tomorrow = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1));
	const runAt = localDateTimeToIso(
		{
			year: tomorrow.getUTCFullYear(),
			month: tomorrow.getUTCMonth() + 1,
			day: tomorrow.getUTCDate(),
			hour: time.hour,
			minute: time.minute,
		},
		timezone,
	);
	return createOneTimeParsedSchedule({
		input,
		runAt,
		timezone,
	});
}

function parseAbsoluteSchedule(input: string, now: Date, timezone: string): ParsedScheduleInput | undefined {
	const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(input);
	if (!match) {
		return undefined;
	}

	const hourValue = Number.parseInt(match[4] ?? "", 10);
	const minuteValue = Number.parseInt(match[5] ?? "0", 10);
	const meridiem = match[6]?.toLowerCase();
	const hour = normalizeParsedHour(hourValue, meridiem);
	assertValidMinute(minuteValue);
	const runAt = localDateTimeToIso(
		{
			year: Number.parseInt(match[1] ?? "", 10),
			month: Number.parseInt(match[2] ?? "", 10),
			day: Number.parseInt(match[3] ?? "", 10),
			hour,
			minute: minuteValue,
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

function parseRecurringWeekdaySchedule(input: string, now: Date, timezone: string): ParsedScheduleInput | undefined {
	const match = /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(.+)$/i.exec(input);
	if (!match) {
		return undefined;
	}

	const weekday = WEEKDAY_NAMES.findIndex((name) => name.toLowerCase() === (match[1] ?? "").toLowerCase());
	if (weekday < 0) {
		throw new Error("Weekday schedule must use a valid weekday name.");
	}

	return createRecurringWeekdayParsedSchedule({
		input,
		now,
		timezone,
		weekday,
		time: parseTimeValue(match[2] ?? ""),
	});
}

function parseRecurringIntervalSchedule(input: string, now: Date, timezone: string): ParsedScheduleInput | undefined {
	const canonicalInput = canonicalizeRecurringIntervalInput(input);
	const match = /^every\s+(?:(\d+)\s+)?(minute|minutes|min|mins|hour|hours|day|days|week|weeks|month|months)(?:\s+at\s+(.+))?$/i.exec(
		canonicalInput,
	);
	if (!match) {
		return undefined;
	}

	const interval = Number.parseInt(match[1] ?? "1", 10);
	if (!Number.isFinite(interval) || interval <= 0) {
		throw new Error("Recurring interval must be a positive whole number.");
	}

	const unit = normalizeIntervalUnit(match[2] ?? "");
	const timeInput = match[3]?.trim();
	if ((unit === "minute" || unit === "hour") && timeInput) {
		throw new Error("Minute and hour recurrences do not support an explicit 'at' time.");
	}

	const time = timeInput ? parseTimeValue(timeInput) : undefined;
	return createRecurringIntervalParsedSchedule({
		input,
		now,
		timezone,
		unit,
		interval,
		time,
		usesInferredTimeOfDay: time === undefined && (unit === "day" || unit === "week" || unit === "month"),
	});
}

function parseTimeValue(input: string): TimeValue {
	const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(input.trim());
	if (!match) {
		throw new Error("Time must use am/pm, for example 5am or 8:30pm.");
	}

	const minute = Number.parseInt(match[2] ?? "0", 10);
	assertValidMinute(minute);
	return {
		hour: normalizeParsedHour(Number.parseInt(match[1] ?? "", 10), (match[3] ?? "").toLowerCase()),
		minute,
	};
}

function normalizeParsedHour(hour: number, meridiem: string | undefined): number {
	if (!Number.isFinite(hour)) {
		throw new Error("Invalid hour value.");
	}

	if (!meridiem) {
		if (hour < 0 || hour > 23) {
			throw new Error("24-hour times must be between 0 and 23.");
		}
		return hour;
	}

	if (hour < 1 || hour > 12) {
		throw new Error("12-hour times must be between 1 and 12.");
	}

	if (meridiem === "am") {
		return hour === 12 ? 0 : hour;
	}

	return hour === 12 ? 12 : hour + 12;
}

function assertValidMinute(minute: number): void {
	if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
		throw new Error("Minutes must be between 00 and 59.");
	}
}

function formatRecurringIntervalText(
	interval: number,
	unit: ScheduledTaskRecurringIntervalUnit,
	timezone: string,
	timeOfDay: string,
): string {
	const quantityText = `${interval} ${unit}${interval === 1 ? "" : "s"}`;
	if (unit === "minute" || unit === "hour") {
		return `Every ${quantityText}`;
	}

	const [hour, minute] = parseTimeOfDayValue(timeOfDay);
	return `Every ${quantityText} at ${formatTimeOfDay(hour, minute)} ${timezone}`;
}

function toTimeOfDayValue(time: TimeValue): string {
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function canonicalizeRecurringIntervalInput(input: string): string {
	const aliasMatch = /^(hourly|daily|weekly|monthly)(?:\s+at\s+(.+))?$/i.exec(input.trim());
	if (!aliasMatch) {
		return input;
	}

	const rawUnit = (aliasMatch[1] ?? "").toLowerCase();
	const unit = rawUnit === "hourly"
		? "hour"
		: rawUnit === "daily"
			? "day"
			: rawUnit === "weekly"
				? "week"
				: "month";
	const timeSuffix = aliasMatch[2] ? ` at ${aliasMatch[2]}` : "";
	return `every 1 ${unit}${timeSuffix}`;
}

function normalizeIntervalUnit(value: string): ScheduledTaskRecurringIntervalUnit {
	const normalized = value.toLowerCase();
	if (normalized.startsWith("min")) {
		return "minute";
	}
	if (normalized.startsWith("hour")) {
		return "hour";
	}
	if (normalized.startsWith("day")) {
		return "day";
	}
	if (normalized.startsWith("week")) {
		return "week";
	}
	return "month";
}

function resolveConfirmationTimeValue(
	rule: ScheduledTaskRecurringIntervalRule,
	resolution: ParsedScheduleResolutionMetadata,
): TimeValue | undefined {
	if (rule.unit === "minute" || rule.unit === "hour" || resolution.usesInferredTimeOfDay) {
		return undefined;
	}

	const [hour, minute] = parseTimeOfDayValue(rule.timeOfDay);
	return { hour, minute };
}

function shouldAnchorRecurringIntervalFromConfirmation(unit: ScheduledTaskRecurringIntervalUnit): boolean {
	return unit === "minute" || unit === "hour";
}

function areParsedSchedulesEquivalent(left: ParsedScheduleInput, right: ParsedScheduleInput): boolean {
	return JSON.stringify(stripScheduleResolution(left)) === JSON.stringify(stripScheduleResolution(right));
}

function stripScheduleResolution(schedule: ParsedScheduleInput): Omit<ParsedScheduleInput, "resolution"> {
	const { resolution: _resolution, ...rest } = schedule;
	return rest;
}
