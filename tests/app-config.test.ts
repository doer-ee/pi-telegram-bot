import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";

describe("loadAppConfig", () => {
	let tempDir: string;
	let workspacePath: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-config-"));
		workspacePath = join(tempDir, "workspace");
		agentDir = join(tempDir, "agent-dir");

		await mkdir(workspacePath, { recursive: true });
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("#given PI_AGENT_DIR is not configured", () => {
		it("#when the variable is omitted #then config loads with agentDir unset", () => {
			const env = createBaseEnv(workspacePath);
			delete env.PI_AGENT_DIR;

			const config = loadAppConfig(env);

			expect(config.agentDir).toBeUndefined();
		});

		it("#when the variable is blank #then config loads with agentDir unset", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, { PI_AGENT_DIR: "" }));

			expect(config.agentDir).toBeUndefined();
		});

		it("#when the variable is whitespace only #then config loads with agentDir unset", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, { PI_AGENT_DIR: "  \n\t  " }));

			expect(config.agentDir).toBeUndefined();
		});
	});

	describe("#given PI_AGENT_DIR is configured", () => {
		it("#when it points to a real directory #then config resolves it", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, { PI_AGENT_DIR: agentDir }));

			expect(config.agentDir).toBe(agentDir);
		});

		it("#when it points to a non-directory path #then config rejects it", async () => {
			const filePath = join(tempDir, "not-a-directory.txt");
			await writeFile(filePath, "hello");

			expect(() => loadAppConfig(createBaseEnv(workspacePath, { PI_AGENT_DIR: filePath }))).toThrowError(
				`PI_AGENT_DIR must point to a directory: ${filePath}`,
			);
		});
	});

	describe("#given PI_SESSION_TITLE_REFINEMENT_MODEL is not configured", () => {
		it("#when config loads #then it defaults to gpt-5.4-mini", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath));

			expect(config.titleRefinementModel).toBe("gpt-5.4-mini");
		});
	});

	describe("#given PI_SESSION_TITLE_REFINEMENT_MODEL is configured", () => {
		it("#when config loads #then it uses the explicit override", () => {
			const config = loadAppConfig(
				createBaseEnv(workspacePath, { PI_SESSION_TITLE_REFINEMENT_MODEL: "openai/gpt-5.4" }),
			);

			expect(config.titleRefinementModel).toBe("openai/gpt-5.4");
		});
	});

	describe("#given Telegram speech-to-text env is not configured", () => {
		it("#when config loads #then speech-to-text stays unconfigured", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath));

			expect(config.speechToText).toBeUndefined();
		});
	});

	describe("#given TELEGRAM_STT_ENABLED is false", () => {
		it("#when config loads #then speech-to-text stays unconfigured", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, { TELEGRAM_STT_ENABLED: "false" }));

			expect(config.speechToText).toBeUndefined();
		});
	});

	describe("#given TELEGRAM_STT_ENABLED is true", () => {
		it("#when no other speech-to-text vars are set #then config uses the built-in service defaults", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, { TELEGRAM_STT_ENABLED: "true" }));

			expect(config.speechToText).toEqual({
				enabled: true,
				baseUrl: "http://10.24.200.204:8000",
				endpointPath: "/transcribe",
				model: "whisper-1",
				prompt: "Transcribe the user's Telegram audio exactly and return only the transcript.",
				timeoutMs: 60000,
			});
		});

		it("#when explicit speech-to-text overrides are set #then config applies them", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, {
				TELEGRAM_STT_ENABLED: "true",
				TELEGRAM_STT_BASE_URL: "http://10.24.200.204:9000/",
				TELEGRAM_STT_ENDPOINT_PATH: "v1/transcribe",
				TELEGRAM_STT_MODEL: "whisper",
				TELEGRAM_STT_PROMPT: "transcribe plainly",
				TELEGRAM_STT_API_KEY: "secret-key",
				TELEGRAM_STT_TIMEOUT_MS: "15000",
			}));

			expect(config.speechToText).toEqual({
				enabled: true,
				baseUrl: "http://10.24.200.204:9000",
				endpointPath: "/v1/transcribe",
				model: "whisper",
				prompt: "transcribe plainly",
				apiKey: "secret-key",
				timeoutMs: 15000,
			});
		});

		it("#when the base url is invalid #then config rejects it", () => {
			expect(() => loadAppConfig(createBaseEnv(workspacePath, {
				TELEGRAM_STT_ENABLED: "true",
				TELEGRAM_STT_BASE_URL: "not-a-url",
			}))).toThrowError("TELEGRAM_STT_BASE_URL must be a valid URL: not-a-url.");
		});

		it("#when the endpoint path omits the leading slash #then config normalizes it", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, {
				TELEGRAM_STT_ENABLED: "true",
				TELEGRAM_STT_ENDPOINT_PATH: "v1/transcribe",
			}));

			expect(config.speechToText?.endpointPath).toBe("/v1/transcribe");
		});
	});

	describe("#given speech-to-text env values are present without opt-in", () => {
		it("#when config loads #then speech-to-text stays unconfigured", () => {
			const config = loadAppConfig(createBaseEnv(workspacePath, {
				TELEGRAM_STT_BASE_URL: "http://10.24.200.204:9000/",
				TELEGRAM_STT_MODEL: "whisper",
			}));

			expect(config.speechToText).toBeUndefined();
		});
	});
});

function createBaseEnv(
	workspacePath: string,
	overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
	return {
		TELEGRAM_BOT_TOKEN: "test-bot-token",
		TELEGRAM_AUTHORIZED_USER_ID: "123456",
		PI_WORKSPACE_PATH: workspacePath,
		BOT_STATE_PATH: join(workspacePath, "..", "state.json"),
		TELEGRAM_STREAM_THROTTLE_MS: "1000",
		TELEGRAM_CHUNK_SIZE: "3500",
		...overrides,
	};
}
