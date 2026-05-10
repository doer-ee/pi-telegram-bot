import { randomUUID } from "node:crypto";

const APP_LOG_PREFIX = "[pi-telegram-bot]";

export interface ProcessLifecycleLogContext {
	pid: number;
	startupInstanceId: string;
}

export function createProcessLifecycleLogContext(options: {
	pid?: number;
	startupInstanceIdFactory?: () => string;
} = {}): ProcessLifecycleLogContext {
	return {
		pid: options.pid ?? process.pid,
		startupInstanceId: options.startupInstanceIdFactory?.() ?? randomUUID(),
	};
}

export function formatProcessLifecycleLogMessage(
	context: ProcessLifecycleLogContext,
	message: string,
): string {
	return `${APP_LOG_PREFIX} ${message} pid=${context.pid} startupInstanceId=${context.startupInstanceId}`;
}
