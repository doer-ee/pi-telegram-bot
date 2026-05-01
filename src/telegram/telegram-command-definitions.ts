export interface TelegramBotCommand {
	readonly command: string;
	readonly description: string;
}

interface TelegramCommandDefinition extends TelegramBotCommand {
	readonly helpUsage?: string;
}

const TELEGRAM_COMMAND_DEFINITIONS: readonly TelegramCommandDefinition[] = [
	{ command: "start", description: "Show bot status and help" },
	{ command: "help", description: "Show available commands" },
	{ command: "status", description: "Show bot and session status" },
	{ command: "new", description: "Create and select a new Pi session" },
	{ command: "sessions", description: "List sessions and select one" },
	{ command: "current", description: "Show the selected session" },
	{ command: "rename", description: "Rename the selected session" },
	{ command: "model", description: "Choose the current session model" },
	{ command: "abort", description: "Abort the active run" },
	{
		command: "schedule",
		description: "Start the schedule flow",
		helpUsage: "schedule",
	},
	{ command: "schedules", description: "List scheduled tasks" },
	{
		command: "unschedule",
		description: "Choose a scheduled task to delete",
		helpUsage: "unschedule",
	},
	{
		command: "runscheduled",
		description: "Choose a scheduled task to run now",
		helpUsage: "runscheduled",
	},
];

export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommand[] = TELEGRAM_COMMAND_DEFINITIONS.map(
	({ command, description }) => ({ command, description }),
);

interface TelegramCommandRegistrar {
	setMyCommands(commands: readonly TelegramBotCommand[]): Promise<unknown>;
}

export function getTelegramHelpLines(): string[] {
	return TELEGRAM_COMMAND_DEFINITIONS.map(({ command, description, helpUsage }) => {
		return `/${helpUsage ?? command} - ${description}`;
	});
}

export async function registerTelegramBotCommands(registrar: TelegramCommandRegistrar): Promise<void> {
	await registrar.setMyCommands(TELEGRAM_BOT_COMMANDS);
}
