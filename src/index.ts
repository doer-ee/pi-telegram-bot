import { loadAppConfig } from "./config/app-config.js";
import { loadProjectEnv } from "./config/project-env.js";
import { PiSdkRuntimeFactory } from "./pi/pi-sdk-runtime-factory.js";
import { createHybridScheduleInputParser, PiScheduleAiParser } from "./scheduler/schedule-ai-parser.js";
import { ScheduledTaskRuntime } from "./scheduler/scheduled-task-runtime.js";
import { SessionCoordinator } from "./session/session-coordinator.js";
import { FileAppStateStore } from "./state/file-app-state-store.js";
import { TelegramBotApp } from "./telegram/telegram-bot-app.js";
import {
	formatScheduledTaskDelayText,
	formatScheduledTaskResultText,
} from "./telegram/telegram-formatters.js";
import { createTelegramMessageClient } from "./telegram/telegram-message-client.js";
import { SessionPinSync } from "./telegram/session-pin-sync.js";
import { Telegram } from "telegraf";

async function main(): Promise<void> {
	loadProjectEnv();

	const config = loadAppConfig();
	const runtimeFactory = new PiSdkRuntimeFactory(config.agentDir, config.titleRefinementModel);
	const stateStore = new FileAppStateStore(config.statePath);
	const coordinator = new SessionCoordinator(config.workspacePath, stateStore, runtimeFactory);
	const telegram = new Telegram(config.telegramBotToken);
	const telegramMessageClient = createTelegramMessageClient(telegram);
	const sessionPinSync = new SessionPinSync(
		telegramMessageClient,
		stateStore,
		config.workspacePath,
		config.authorizedTelegramUserId,
	);
	const scheduleInputParser = createHybridScheduleInputParser({
		aiFallback: new PiScheduleAiParser(runtimeFactory, config.workspacePath),
	});
	const scheduler = new ScheduledTaskRuntime(config.workspacePath, stateStore, coordinator, {
	onDelayed: async (event) => {
		await telegramMessageClient.sendText(config.authorizedTelegramUserId, formatScheduledTaskDelayText(event));
	},
	onCompleted: async (event) => {
		await telegramMessageClient.sendText(
			config.authorizedTelegramUserId,
			formatScheduledTaskResultText(event),
			{ silent: true },
		);
	},
	onFailed: async (event) => {
		await telegramMessageClient.sendText(config.authorizedTelegramUserId, formatScheduledTaskResultText(event));
	},
});
	const app = new TelegramBotApp(config, coordinator, sessionPinSync, scheduler, scheduleInputParser);

	const shutdown = createShutdownHandler(app);
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await app.start();
	console.log("[pi-telegram-bot] bot started");
}

function createShutdownHandler(app: TelegramBotApp) {
	let shuttingDown = false;

	return async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;

		try {
			console.log(`[pi-telegram-bot] stopping on ${signal}`);
			await app.stop(signal);
		} catch (error) {
			console.error("[pi-telegram-bot] shutdown failed:", error);
			process.exitCode = 1;
		}
	};
}

void main().catch((error) => {
	console.error("[pi-telegram-bot] startup failed:", error);
	process.exitCode = 1;
});
