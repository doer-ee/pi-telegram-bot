import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_TITLE_REFINEMENT_MODEL } from "./title-refinement-model.js";

const OptionalNonBlankStringSchema = z.preprocess(
	normalizeOptionalNonBlankString,
	z.string().min(1).optional(),
);

const EnvSchema = z.object({
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	TELEGRAM_AUTHORIZED_USER_ID: z.coerce.number().int().positive(),
	PI_WORKSPACE_PATH: z.string().min(1),
	BOT_STATE_PATH: z.string().min(1).default("./data/state.json"),
	PI_AGENT_DIR: OptionalNonBlankStringSchema,
	PI_SESSION_TITLE_REFINEMENT_MODEL: z.preprocess(
		normalizeOptionalNonBlankString,
		z.string().min(1).default(DEFAULT_TITLE_REFINEMENT_MODEL),
	),
	TELEGRAM_STREAM_THROTTLE_MS: z.coerce.number().int().min(250).default(1000),
	TELEGRAM_CHUNK_SIZE: z.coerce.number().int().min(512).max(4000).default(3500),
});

export interface AppConfig {
	telegramBotToken: string;
	authorizedTelegramUserId: number;
	workspacePath: string;
	statePath: string;
	agentDir: string | undefined;
	titleRefinementModel: string;
	streamThrottleMs: number;
	telegramChunkSize: number;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const parsed = EnvSchema.parse(env);
	const workspacePath = toAbsolutePath(parsed.PI_WORKSPACE_PATH);
	assertDirectoryExists(workspacePath, "PI_WORKSPACE_PATH");

	const agentDir = parsed.PI_AGENT_DIR ? toAbsolutePath(parsed.PI_AGENT_DIR) : undefined;
	if (agentDir) {
		assertDirectoryExists(agentDir, "PI_AGENT_DIR");
	}

	return {
		telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
		authorizedTelegramUserId: parsed.TELEGRAM_AUTHORIZED_USER_ID,
		workspacePath,
		statePath: toAbsolutePath(parsed.BOT_STATE_PATH),
		agentDir,
		titleRefinementModel: parsed.PI_SESSION_TITLE_REFINEMENT_MODEL,
		streamThrottleMs: parsed.TELEGRAM_STREAM_THROTTLE_MS,
		telegramChunkSize: parsed.TELEGRAM_CHUNK_SIZE,
	};
}

function toAbsolutePath(value: string): string {
	return resolve(process.cwd(), value);
}

function normalizeOptionalNonBlankString(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}

	const normalizedValue = value.trim();
	return normalizedValue.length > 0 ? normalizedValue : undefined;
}

function assertDirectoryExists(path: string, label: string): void {
	let stats;
	try {
		stats = statSync(path);
	} catch (error) {
		throw new Error(`${label} does not exist: ${path}. ${formatError(error)}`);
	}

	if (!stats.isDirectory()) {
		throw new Error(`${label} must point to a directory: ${path}`);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
