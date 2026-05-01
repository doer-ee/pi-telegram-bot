export type ScheduledTaskTarget =
	| {
			type: "new_session";
	  }
	| {
			type: "existing_session";
			sessionPath: string;
			sessionId: string;
			sessionName?: string | undefined;
	  };

export interface OneTimeScheduleDefinition {
	kind: "one_time";
	input: string;
	normalizedText: string;
	timezone: string;
	runAt: string;
}

export interface ScheduledTaskRecurringWeekdayRule {
	type: "weekday";
	weekday: number;
	timeOfDay: string;
}

export type ScheduledTaskRecurringIntervalUnit = "minute" | "hour" | "day" | "week" | "month";

export interface ScheduledTaskRecurringIntervalRule {
	type: "interval";
	unit: ScheduledTaskRecurringIntervalUnit;
	interval: number;
	anchorAt: string;
	timeOfDay: string;
}

export interface RecurringScheduleDefinition {
	kind: "recurring";
	input: string;
	normalizedText: string;
	timezone: string;
	firstRunAt: string;
	rule: ScheduledTaskRecurringWeekdayRule | ScheduledTaskRecurringIntervalRule;
}

export type ScheduledTaskSchedule = OneTimeScheduleDefinition | RecurringScheduleDefinition;

export interface ParsedScheduleResolutionMetadata {
	anchorFromConfirmation?: boolean | undefined;
	usesInferredTimeOfDay?: boolean | undefined;
}

export interface ParsedScheduleInput {
	kind: "one_time" | "recurring";
	schedule: ScheduledTaskSchedule;
	nextRunAt: string;
	normalizedText: string;
	timezone: string;
	resolution?: ParsedScheduleResolutionMetadata | undefined;
}

export interface ScheduledTask {
	id: string;
	kind: "one_time" | "recurring";
	prompt: string;
	createdAt: string;
	updatedAt: string;
	nextRunAt: string;
	scheduledForAt: string;
	lastRunAt?: string | undefined;
	busyRetryCount?: number | undefined;
	target: ScheduledTaskTarget;
	schedule: ScheduledTaskSchedule;
}
