export const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

export interface LocalDateTimeParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

export function getServerTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatScheduleInstant(iso: string, timezone: string): string {
	return `${formatLocalDateTime(requireScheduledTaskDate(iso), timezone)} ${timezone}`;
}

export function formatLocalDateTime(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).formatToParts(date);
	const values = Object.fromEntries(
		parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
	) as Record<string, string>;
	return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}${values.dayPeriod?.toUpperCase() ?? ""}`;
}

export function formatTimeOfDay(hour: number, minute: number): string {
	const date = new Date(Date.UTC(2026, 0, 1, hour, minute));
	return new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
		timeZone: "UTC",
	})
		.format(date)
		.replace(/\s+/g, "")
		.toLowerCase();
}

export function getLocalDateTimeParts(date: Date, timezone: string): LocalDateTimeParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const values = Object.fromEntries(
		parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
	) as Record<string, string>;
	return {
		year: Number.parseInt(values.year ?? "0", 10),
		month: Number.parseInt(values.month ?? "0", 10),
		day: Number.parseInt(values.day ?? "0", 10),
		hour: Number.parseInt(values.hour ?? "0", 10),
		minute: Number.parseInt(values.minute ?? "0", 10),
	};
}

export function getLocalWeekday(date: Date, timezone: string): number {
	const weekdayLabel = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date);
	return WEEKDAY_NAMES.findIndex((name) => name === weekdayLabel);
}

export function addLocalDays(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
	const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute));
	return {
		year: utcDate.getUTCFullYear(),
		month: utcDate.getUTCMonth() + 1,
		day: utcDate.getUTCDate(),
		hour: parts.hour,
		minute: parts.minute,
	};
}

export function localDateTimeToIso(parts: LocalDateTimeParts, timezone: string): string {
	let guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
	const targetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const zonedParts = getLocalDateTimeParts(guess, timezone);
		const zonedMs = Date.UTC(
			zonedParts.year,
			zonedParts.month - 1,
			zonedParts.day,
			zonedParts.hour,
			zonedParts.minute,
		);
		const deltaMs = targetMs - zonedMs;
		if (deltaMs === 0) {
			return guess.toISOString();
		}
		guess = new Date(guess.getTime() + deltaMs);
	}
	return guess.toISOString();
}

export function addDaysInTimezone(iso: string, days: number, timezone: string, timeOfDay: string): string {
	const parts = getLocalDateTimeParts(requireScheduledTaskDate(iso), timezone);
	const nextDate = addLocalDays(parts, days);
	const [hour, minute] = parseTimeOfDayValue(timeOfDay);
	return localDateTimeToIso({ ...nextDate, hour, minute }, timezone);
}

export function addMonthsToAnchoredOccurrence(
	anchorAt: string,
	monthsFromAnchor: number,
	timezone: string,
	timeOfDay: string,
): string {
	const anchorParts = getLocalDateTimeParts(requireScheduledTaskDate(anchorAt), timezone);
	const totalMonths = anchorParts.month - 1 + monthsFromAnchor;
	const year = anchorParts.year + Math.floor(totalMonths / 12);
	const month = ((totalMonths % 12) + 12) % 12 + 1;
	const lastDay = getDaysInMonth(year, month);
	const [hour, minute] = parseTimeOfDayValue(timeOfDay);
	return localDateTimeToIso(
		{
			year,
			month,
			day: Math.min(anchorParts.day, lastDay),
			hour,
			minute,
		},
		timezone,
	);
}

export function getLocalMonthIndexDifference(anchorAt: string, occurrenceAt: string, timezone: string): number {
	const anchorParts = getLocalDateTimeParts(requireScheduledTaskDate(anchorAt), timezone);
	const occurrenceParts = getLocalDateTimeParts(requireScheduledTaskDate(occurrenceAt), timezone);
	return (occurrenceParts.year - anchorParts.year) * 12 + (occurrenceParts.month - anchorParts.month);
}

export function toTimeOfDayValue(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTimeOfDayValue(value: string): [number, number] {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) {
		throw new Error(`Invalid stored time of day: ${value}`);
	}
	return [Number.parseInt(match[1] ?? "", 10), Number.parseInt(match[2] ?? "", 10)];
}

export function requireScheduledTaskDate(value: string): Date {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`Invalid scheduled task date/time: ${value}`);
	}
	return parsed;
}

function getDaysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
