import dotenv, { type DotenvParseOutput } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getProjectEnvPath(env: NodeJS.ProcessEnv = process.env): string {
	const configuredEnvPath = env.PI_TELEGRAM_BOT_ENV_PATH?.trim();
	if (configuredEnvPath) {
		return resolve(configuredEnvPath);
	}

	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
}

export function loadProjectEnv(
	env: NodeJS.ProcessEnv = process.env,
	envPath: string = getProjectEnvPath(env),
): DotenvParseOutput {
	const resolvedEnvPath = resolve(envPath);

	try {
		const parsed = dotenv.parse(readFileSync(resolvedEnvPath));

		for (const [key, value] of Object.entries(parsed)) {
			env[key] = value;
		}

		return parsed;
	} catch (error) {
		throw new Error(
			`Failed to load project env file at ${resolvedEnvPath}: ${formatError(error)}`,
		);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
