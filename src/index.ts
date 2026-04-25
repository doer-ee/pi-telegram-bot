import { loadAppConfig } from "./config/app-config.js";
import { loadProjectEnv } from "./config/project-env.js";
import { PiSdkRuntimeFactory } from "./pi/pi-sdk-runtime-factory.js";
import { SessionCoordinator } from "./session/session-coordinator.js";
import { FileAppStateStore } from "./state/file-app-state-store.js";
import { TelegramBotApp } from "./telegram/telegram-bot-app.js";
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
	const sessionPinSync = new SessionPinSync(
		createTelegramMessageClient(telegram),
		stateStore,
		config.workspacePath,
		config.authorizedTelegramUserId,
	);
	const app = new TelegramBotApp(config, coordinator, sessionPinSync);

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
