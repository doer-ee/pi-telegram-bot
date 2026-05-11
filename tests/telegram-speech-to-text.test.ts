import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWhisperSpeechToTextTranscriber,
	SpeechToTextError,
	type ResolvedSpeechToTextConfig,
} from "../src/telegram/telegram-speech-to-text.js";

describe("createWhisperSpeechToTextTranscriber", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("posts multipart audio to the configured Whisper-style endpoint and returns the trimmed transcript", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("http://10.24.200.204:8000/transcribe");
			expect(init?.method).toBe("POST");

			const formData = init?.body;
			expect(formData).toBeInstanceOf(FormData);
			if (!(formData instanceof FormData)) {
				throw new Error("Expected a multipart FormData body.");
			}

			expect(formData.get("model")).toBe("whisper-1");
			expect(formData.get("prompt")).toBe("return only the transcript");

			const uploadedFile = formData.get("file");
			expect(isFileLike(uploadedFile)).toBe(true);
			if (!isFileLike(uploadedFile)) {
				throw new Error("Expected an uploaded audio file in multipart form data.");
			}

			expect(uploadedFile.name).toBe("voice-note.ogg");
			expect(uploadedFile.type).toBe("audio/ogg");
			expect(await uploadedFile.text()).toBe("voice-bytes");

			return new Response(JSON.stringify({ text: "  transcribed voice prompt  " }), {
				status: 200,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const transcriber = createWhisperSpeechToTextTranscriber(createConfig({
			prompt: "return only the transcript",
		}));

		await expect(
			transcriber.transcribe({
				buffer: Buffer.from("voice-bytes"),
				filePath: "/tmp/telegram-upload-1/voice-note.ogg",
				fileName: "voice-note.ogg",
				mimeType: "audio/ogg",
			}),
		).resolves.toBe("transcribed voice prompt");
	});

	it("supports top-level transcript responses and optional bearer auth", async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.headers).toEqual({ Authorization: "Bearer secret-key" });

			return new Response(JSON.stringify({ transcript: "audio summary" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const transcriber = createWhisperSpeechToTextTranscriber(createConfig({ apiKey: "secret-key" }));

		await expect(
			transcriber.transcribe({
				buffer: Buffer.from("audio-bytes"),
				filePath: "/tmp/telegram-upload-1/meeting.m4a",
				fileName: "meeting.m4a",
				mimeType: "audio/mp4",
			}),
		).resolves.toBe("audio summary");
	});

	it("fails explicitly when the service returns a non-success status", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			return new Response("upstream overload", { status: 503, headers: { "content-type": "text/plain" } });
		}));

		const transcriber = createWhisperSpeechToTextTranscriber(createConfig());

		await expect(
			transcriber.transcribe({
				buffer: Buffer.from("voice-bytes"),
				filePath: "/tmp/telegram-upload-1/voice-note.ogg",
				fileName: "voice-note.ogg",
				mimeType: "audio/ogg",
			}),
		).rejects.toThrow(
			"Speech to text request failed with status 503 from http://10.24.200.204:8000/transcribe: upstream overload",
		);
	});

	it("fails explicitly when the JSON response does not contain a transcript", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			return new Response(JSON.stringify({ language: "en" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}));

		const transcriber = createWhisperSpeechToTextTranscriber(createConfig());

		await expect(
			transcriber.transcribe({
				buffer: Buffer.from("voice-bytes"),
				filePath: "/tmp/telegram-upload-1/voice-note.ogg",
				fileName: "voice-note.ogg",
				mimeType: "audio/ogg",
			}),
		).rejects.toThrow("Speech to text service returned JSON without a top-level text or transcript string.");
	});

	it("fails explicitly when the service times out", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			const abortError = new Error("The operation was aborted.");
			Reflect.set(abortError, "name", "AbortError");
			throw abortError;
		}));

		const transcriber = createWhisperSpeechToTextTranscriber(createConfig({ timeoutMs: 5_000 }));

		await expect(transcriber.transcribe({
			buffer: Buffer.from("voice-bytes"),
			filePath: "/tmp/telegram-upload-1/voice-note.ogg",
			fileName: "voice-note.ogg",
			mimeType: "audio/ogg",
		})).rejects.toThrow(
			"Speech to text request to http://10.24.200.204:8000/transcribe timed out after 5000ms.",
		);
	});
});

function createConfig(overrides: Partial<ResolvedSpeechToTextConfig> = {}): ResolvedSpeechToTextConfig {
	return {
		baseUrl: "http://10.24.200.204:8000",
		endpointPath: "/transcribe",
		model: "whisper-1",
		prompt: "transcribe this audio",
		timeoutMs: 60_000,
		...overrides,
	};
}

function isFileLike(value: unknown): value is File {
	return value instanceof File;
}

describe("SpeechToTextError", () => {
	it("preserves the provided user-facing message", () => {
		expect(new SpeechToTextError("custom message").message).toBe("custom message");
	});
});
