import type {
	RecurringScheduleDefinition,
	ScheduledTaskRecurringIntervalRule,
	ScheduledTaskSchedule,
} from "./scheduled-task-types.js";
import {
	addDaysInTimezone,
	addLocalDays,
	addMonthsToAnchoredOccurrence,
	getLocalDateTimeParts,
	getLocalMonthIndexDifference,
	getLocalWeekday,
	localDateTimeToIso,
	requireScheduledTaskDate,
	toTimeOfDayValue,
} from "./schedule-time.js";

export function computeFirstWeekdayRunAt(
	now: Date,
	timezone: string,
	weekday: number,
	hour: number,
	minute: number,
): string {
	const localNow = getLocalDateTimeParts(now, timezone);
	const currentWeekday = getLocalWeekday(now, timezone);
	const daysUntil = (weekday - currentWeekday + 7) % 7;
	const candidateDate = addLocalDays(localNow, daysUntil);
	let candidateIso = localDateTimeToIso({ ...candidateDate, hour, minute }, timezone);
	if (requireScheduledTaskDate(candidateIso).getTime() <= now.getTime()) {
		candidateIso = addDaysInTimezone(candidateIso, 7, timezone, toTimeOfDayValue(hour, minute));
	}
	return candidateIso;
}

export function computeFirstIntervalRunAt(
	now: Date,
	timezone: string,
	unit: ScheduledTaskRecurringIntervalRule["unit"],
	interval: number,
	time?: { hour: number; minute: number },
): { anchorAt: string; firstRunAt: string; timeOfDay: string } {
	if (unit === "minute" || unit === "hour") {
		const intervalMs = interval * (unit === "minute" ? 60_000 : 3_600_000);
		const localNow = getLocalDateTimeParts(now, timezone);
		return {
			anchorAt: now.toISOString(),
			firstRunAt: new Date(now.getTime() + intervalMs).toISOString(),
			timeOfDay: toTimeOfDayValue(localNow.hour, localNow.minute),
		};
	}

	const localNow = getLocalDateTimeParts(now, timezone);
	const resolvedTime = time ?? {
		hour: localNow.hour,
		minute: localNow.minute,
	};
	const anchorAt = localDateTimeToIso(
		{
			...localNow,
			hour: resolvedTime.hour,
			minute: resolvedTime.minute,
		},
		timezone,
	);
	const timeOfDay = toTimeOfDayValue(resolvedTime.hour, resolvedTime.minute);
	let candidate = anchorAt;
	if (requireScheduledTaskDate(candidate).getTime() <= now.getTime()) {
		candidate = advanceIntervalOccurrence(
			{
				type: "interval",
				unit,
				interval,
				anchorAt,
				timeOfDay,
			},
			timezone,
			anchorAt,
		);
		while (requireScheduledTaskDate(candidate).getTime() <= now.getTime()) {
			candidate = advanceIntervalOccurrence(
				{
					type: "interval",
					unit,
					interval,
					anchorAt,
					timeOfDay,
				},
				timezone,
				candidate,
			);
		}
	}

	return {
		anchorAt,
		firstRunAt: candidate,
		timeOfDay,
	};
}

export function computeNextRunAt(
	schedule: ScheduledTaskSchedule,
	currentOccurrenceAt: string,
	afterAt = currentOccurrenceAt,
): string {
	if (schedule.kind !== "recurring") {
		return schedule.runAt;
	}

	const afterTime = requireScheduledTaskDate(afterAt).getTime();
	let candidate = advanceRecurringOccurrence(schedule, currentOccurrenceAt);
	while (requireScheduledTaskDate(candidate).getTime() <= afterTime) {
		candidate = advanceRecurringOccurrence(schedule, candidate);
	}
	return candidate;
}

function advanceRecurringOccurrence(schedule: RecurringScheduleDefinition, currentOccurrenceAt: string): string {
	if (schedule.rule.type === "weekday") {
		return addDaysInTimezone(currentOccurrenceAt, 7, schedule.timezone, schedule.rule.timeOfDay);
	}

	return advanceIntervalOccurrence(schedule.rule, schedule.timezone, currentOccurrenceAt);
}

function advanceIntervalOccurrence(
	rule: ScheduledTaskRecurringIntervalRule,
	timezone: string,
	currentOccurrenceAt: string,
): string {
	if (rule.unit === "minute" || rule.unit === "hour") {
		const intervalMs = rule.interval * (rule.unit === "minute" ? 60_000 : 3_600_000);
		return new Date(requireScheduledTaskDate(currentOccurrenceAt).getTime() + intervalMs).toISOString();
	}

	if (rule.unit === "day") {
		return addDaysInTimezone(currentOccurrenceAt, rule.interval, timezone, rule.timeOfDay);
	}

	if (rule.unit === "week") {
		return addDaysInTimezone(currentOccurrenceAt, rule.interval * 7, timezone, rule.timeOfDay);
	}

	const currentIndex = getLocalMonthIndexDifference(rule.anchorAt, currentOccurrenceAt, timezone);
	return addMonthsToAnchoredOccurrence(rule.anchorAt, currentIndex + rule.interval, timezone, rule.timeOfDay);
}
