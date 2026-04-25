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
