import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_TITLE_REFINEMENT_MODEL } from "./title-refinement-model.js";

const OptionalNonBlankStringSchema = z.preprocess(
	normalizeOptionalNonBlankString,
	z.string().min(1).optional(),
);

const OptionalBooleanFromEnvSchema = z.preprocess(
	normalizeOptionalBoolean,
	z.boolean().optional(),
);

export const DEFAULT_TELEGRAM_STT_BASE_URL = "http://10.24.200.204:8000";
export const DEFAULT_TELEGRAM_STT_ENDPOINT_PATH = "/transcribe";
export const DEFAULT_TELEGRAM_STT_MODEL = "whisper-1";
export const DEFAULT_TELEGRAM_STT_PROMPT =
	"Transcribe the user's Telegram audio exactly and return only the transcript.";
export const DEFAULT_TELEGRAM_STT_TIMEOUT_MS = 60_000;

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
	TELEGRAM_STT_ENABLED: OptionalBooleanFromEnvSchema,
	TELEGRAM_STT_BASE_URL: OptionalNonBlankStringSchema,
	TELEGRAM_STT_ENDPOINT_PATH: OptionalNonBlankStringSchema,
	TELEGRAM_STT_MODEL: OptionalNonBlankStringSchema,
	TELEGRAM_STT_PROMPT: OptionalNonBlankStringSchema,
	TELEGRAM_STT_API_KEY: OptionalNonBlankStringSchema,
	TELEGRAM_STT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(DEFAULT_TELEGRAM_STT_TIMEOUT_MS),
});

export interface SpeechToTextConfig {
	enabled: boolean;
	baseUrl: string;
	endpointPath: string;
	model: string;
	prompt: string;
	apiKey?: string;
	timeoutMs: number;
}

export interface AppConfig {
	telegramBotToken: string;
	authorizedTelegramUserId: number;
	workspacePath: string;
	statePath: string;
	agentDir: string | undefined;
	titleRefinementModel: string;
	streamThrottleMs: number;
	telegramChunkSize: number;
	speechToText?: SpeechToTextConfig;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const parsed = EnvSchema.parse(env);
	const workspacePath = toAbsolutePath(parsed.PI_WORKSPACE_PATH);
	assertDirectoryExists(workspacePath, "PI_WORKSPACE_PATH");

	const agentDir = parsed.PI_AGENT_DIR ? toAbsolutePath(parsed.PI_AGENT_DIR) : undefined;
	if (agentDir) {
		assertDirectoryExists(agentDir, "PI_AGENT_DIR");
	}

	const speechToText = buildSpeechToTextConfig(parsed);

	return {
		telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
		authorizedTelegramUserId: parsed.TELEGRAM_AUTHORIZED_USER_ID,
		workspacePath,
		statePath: toAbsolutePath(parsed.BOT_STATE_PATH),
		agentDir,
		titleRefinementModel: parsed.PI_SESSION_TITLE_REFINEMENT_MODEL,
		streamThrottleMs: parsed.TELEGRAM_STREAM_THROTTLE_MS,
		telegramChunkSize: parsed.TELEGRAM_CHUNK_SIZE,
		...(speechToText ? { speechToText } : {}),
	};
}

function buildSpeechToTextConfig(parsed: z.infer<typeof EnvSchema>): SpeechToTextConfig | undefined {
	if (parsed.TELEGRAM_STT_ENABLED !== true) {
		return undefined;
	}

	const baseUrl = parsed.TELEGRAM_STT_BASE_URL ?? DEFAULT_TELEGRAM_STT_BASE_URL;
	const endpointPath = parsed.TELEGRAM_STT_ENDPOINT_PATH ?? DEFAULT_TELEGRAM_STT_ENDPOINT_PATH;
	const model = parsed.TELEGRAM_STT_MODEL ?? DEFAULT_TELEGRAM_STT_MODEL;
	const prompt = parsed.TELEGRAM_STT_PROMPT ?? DEFAULT_TELEGRAM_STT_PROMPT;

	return {
		enabled: true,
		baseUrl: normalizeConfiguredUrl(baseUrl, "TELEGRAM_STT_BASE_URL"),
		endpointPath: normalizeSpeechToTextEndpointPath(endpointPath),
		model,
		prompt,
		...(parsed.TELEGRAM_STT_API_KEY !== undefined ? { apiKey: parsed.TELEGRAM_STT_API_KEY } : {}),
		timeoutMs: parsed.TELEGRAM_STT_TIMEOUT_MS,
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

function normalizeOptionalBoolean(value: unknown): unknown {
	if (typeof value === "boolean" || value === undefined) {
		return value;
	}

	if (typeof value !== "string") {
		return value;
	}

	const normalizedValue = value.trim().toLowerCase();
	if (normalizedValue.length === 0) {
		return undefined;
	}

	if (["1", "true", "yes", "on"].includes(normalizedValue)) {
		return true;
	}

	if (["0", "false", "no", "off"].includes(normalizedValue)) {
		return false;
	}

	return value;
}

function normalizeConfiguredUrl(value: string, label: string): string {
	try {
		const normalized = new URL(value).toString().replace(/\/+$/u, "");
		return normalized.length > 0 ? normalized : value;
	} catch (error) {
		throw new Error(`${label} must be a valid URL: ${value}. ${formatError(error)}`);
	}
}

function normalizeSpeechToTextEndpointPath(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		return DEFAULT_TELEGRAM_STT_ENDPOINT_PATH;
	}

	return normalized.startsWith("/") ? normalized : `/${normalized}`;
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
