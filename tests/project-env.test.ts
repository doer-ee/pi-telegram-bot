import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { getProjectEnvPath, loadProjectEnv } from "../src/config/project-env.js";

describe("loadProjectEnv", () => {
	let tempDir: string;
	let workspacePath: string;
	let envFilePath: string;
	let statePath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-project-env-"));
		workspacePath = join(tempDir, "workspace");
		envFilePath = join(tempDir, ".env");
		statePath = join(tempDir, "state.json");

		await mkdir(workspacePath, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("#given inherited shell env already defines TELEGRAM_BOT_TOKEN", () => {
		it("#when the project .env is loaded #then loadAppConfig prefers the project token", async () => {
			await writeFile(
				envFilePath,
				[
					"TELEGRAM_BOT_TOKEN=project-bot-token",
					"TELEGRAM_AUTHORIZED_USER_ID=123456",
					`PI_WORKSPACE_PATH=${workspacePath}`,
					`BOT_STATE_PATH=${statePath}`,
				].join("\n"),
			);

			const env: NodeJS.ProcessEnv = {
				TELEGRAM_BOT_TOKEN: "inherited-shell-token",
				PI_TELEGRAM_BOT_ENV_PATH: envFilePath,
			};

			const parsed = loadProjectEnv(env);
			const config = loadAppConfig(env);

			expect(parsed.TELEGRAM_BOT_TOKEN).toBe("project-bot-token");
			expect(env.TELEGRAM_BOT_TOKEN).toBe("project-bot-token");
			expect(config.telegramBotToken).toBe("project-bot-token");
		});
	});

	describe("#given the configured project env file cannot be read", () => {
		it("#when loadProjectEnv runs #then it throws instead of continuing with inherited env", () => {
			const missingEnvPath = join(tempDir, "missing.env");
			const env: NodeJS.ProcessEnv = {
				TELEGRAM_BOT_TOKEN: "inherited-shell-token",
				PI_TELEGRAM_BOT_ENV_PATH: missingEnvPath,
			};

			expect(() => loadProjectEnv(env)).toThrowError(
				`Failed to load project env file at ${missingEnvPath}: ENOENT: no such file or directory, open '${missingEnvPath}'`,
			);
			expect(env.TELEGRAM_BOT_TOKEN).toBe("inherited-shell-token");
		});
	});

	describe("#given the app resolves its startup env file", () => {
		it("#when the default path is requested #then it points at pi-telegram-bot/.env", () => {
			const expectedProjectEnvPath = resolve(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				".env",
			);

			expect(getProjectEnvPath()).toBe(expectedProjectEnvPath);
		});

		it("#when PI_TELEGRAM_BOT_ENV_PATH is set #then it prefers that explicit file", () => {
			expect(
				getProjectEnvPath({
					PI_TELEGRAM_BOT_ENV_PATH: envFilePath,
				}),
			).toBe(envFilePath);
		});
	});
});
