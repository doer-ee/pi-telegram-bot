export interface TelegramBotCommand {
	readonly command: string;
	readonly description: string;
}

interface TelegramCommandDefinition extends TelegramBotCommand {
	readonly helpUsage?: string;
}

const TELEGRAM_COMMAND_DEFINITIONS: readonly TelegramCommandDefinition[] = [
	{ command: "new", description: "Create and select a new Pi session" },
	{ command: "sessions", description: "List sessions and select one" },
	{ command: "model", description: "Choose the current session model" },
	{
		command: "schedule",
		description: "Start the schedule flow",
		helpUsage: "schedule",
	},
	{ command: "schedules", description: "List scheduled tasks" },
	{ command: "rename", description: "Rename the selected session" },
	{ command: "abort", description: "Abort the active run" },
	{ command: "start", description: "Show bot status and help" },
	{ command: "status", description: "Show bot and session status" },
	{ command: "current", description: "Show the selected session" },
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
	{ command: "help", description: "Show available commands" },
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
