import type { SpeechToTextConfig } from "../config/app-config.js";

export const SPEECH_TO_TEXT_NOT_CONFIGURED_MESSAGE =
	"Speech to text is not configured. Please configure it first.";

export interface ResolvedSpeechToTextConfig {
	baseUrl: string;
	endpointPath: string;
	model: string;
	prompt: string;
	apiKey?: string;
	timeoutMs: number;
}

export interface SpeechToTextUpload {
	buffer: Buffer;
	filePath: string;
	fileName: string;
	mimeType: string;
}

export interface SpeechToTextTranscriber {
	transcribe(upload: SpeechToTextUpload): Promise<string>;
}

export class SpeechToTextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpeechToTextError";
	}
}

export class SpeechToTextNotConfiguredError extends SpeechToTextError {
	constructor() {
		super(SPEECH_TO_TEXT_NOT_CONFIGURED_MESSAGE);
		this.name = "SpeechToTextNotConfiguredError";
	}
}

export function resolveSpeechToTextConfig(
	config: SpeechToTextConfig | undefined,
): ResolvedSpeechToTextConfig | undefined {
	if (!config?.enabled) {
		return undefined;
	}

	const baseUrl = config.baseUrl.trim();
	const endpointPath = config.endpointPath.trim();
	const model = config.model.trim();
	const prompt = config.prompt.trim();
	if (baseUrl.length === 0 || endpointPath.length === 0 || model.length === 0) {
		return undefined;
	}

	return {
		baseUrl,
		endpointPath,
		model,
		prompt,
		...(config.apiKey !== undefined ? { apiKey: config.apiKey.trim() } : {}),
		timeoutMs: config.timeoutMs,
	};
}

export function requireSpeechToTextConfig(
	config: SpeechToTextConfig | undefined,
): ResolvedSpeechToTextConfig {
	const resolved = resolveSpeechToTextConfig(config);
	if (!resolved) {
		throw new SpeechToTextNotConfiguredError();
	}

	return resolved;
}

export function createWhisperSpeechToTextTranscriber(
	config: ResolvedSpeechToTextConfig,
): SpeechToTextTranscriber {
	const url = buildSpeechToTextUrl(config.baseUrl, config.endpointPath);

	return {
		transcribe: async (upload) => {
			const formData = new FormData();
			formData.append("file", new Blob([upload.buffer], { type: upload.mimeType }), upload.fileName);
			formData.append("model", config.model);
			if (config.prompt.length > 0) {
				formData.append("prompt", config.prompt);
			}

			const controller = new AbortController();
			const timeoutHandle = setTimeout(() => {
				controller.abort();
			}, config.timeoutMs);

			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					body: formData,
					headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
					signal: controller.signal,
				});
			} catch (error) {
				if (isAbortError(error)) {
					throw new SpeechToTextError(
						`Speech to text request to ${url} timed out after ${config.timeoutMs}ms.`,
					);
				}

				throw new SpeechToTextError(`Speech to text request failed: ${describeSpeechToTextTransportFailure(error)}`);
			} finally {
				clearTimeout(timeoutHandle);
			}

			if (!response.ok) {
				const failureDetails = await describeSpeechToTextHttpFailure(response);
				throw new SpeechToTextError(
					failureDetails.length > 0
						? `Speech to text request failed with status ${response.status} from ${url}: ${failureDetails}`
						: `Speech to text request failed with status ${response.status} from ${url}.`,
				);
			}

			return parseSpeechToTextTranscript(response);
		},
	};
}

function buildSpeechToTextUrl(baseUrl: string, endpointPath: string): string {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");
	const normalizedEndpointPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
	const url = `${normalizedBaseUrl}${normalizedEndpointPath}`;

	try {
		return new URL(url).toString();
	} catch (error) {
		throw new SpeechToTextError(
			`Speech to text is configured with an invalid service URL (${url}): ${describeSpeechToTextTransportFailure(error)}`,
		);
	}
}

async function parseSpeechToTextTranscript(response: Response): Promise<string> {
	const responseText = await response.text();
	const contentType = normalizeMimeType(response.headers.get("content-type"));

	if (isJsonMimeType(contentType)) {
		let payload: unknown;
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			throw new SpeechToTextError(
				`Speech to text service returned invalid JSON: ${describeSpeechToTextTransportFailure(error)}`,
			);
		}

		const transcript = extractTranscriptFromJson(payload);
		if (transcript === undefined) {
			throw new SpeechToTextError(
				"Speech to text service returned JSON without a top-level text or transcript string.",
			);
		}

		return normalizeTranscript(transcript);
	}

	return normalizeTranscript(responseText);
}

function extractTranscriptFromJson(payload: unknown): string | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}

	if (typeof payload.text === "string") {
		return payload.text;
	}

	if (typeof payload.transcript === "string") {
		return payload.transcript;
	}

	return undefined;
}

function normalizeTranscript(value: string): string {
	const transcript = value.trim();
	if (transcript.length === 0) {
		throw new SpeechToTextError("Speech to text service returned an empty transcript.");
	}

	return transcript;
}

async function describeSpeechToTextHttpFailure(response: Response): Promise<string> {
	try {
		const responseText = response.headers.get("content-type")?.includes("application/json")
			? JSON.stringify(await response.json())
			: await response.text();
		return truncateAndNormalizeWhitespace(responseText);
	} catch {
		return "";
	}
}

function describeSpeechToTextTransportFailure(error: unknown): string {
	if (error instanceof Error) {
		return truncateAndNormalizeWhitespace(error.message);
	}

	return truncateAndNormalizeWhitespace(String(error));
}

function truncateAndNormalizeWhitespace(value: string, maxLength = 200): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeMimeType(value: string | null | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const [mimeType] = value.split(";", 1);
	const normalized = mimeType?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function isJsonMimeType(mimeType: string | undefined): boolean {
	return mimeType === "application/json" || mimeType?.endsWith("+json") === true;
}

function isAbortError(error: unknown): boolean {
	return isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
