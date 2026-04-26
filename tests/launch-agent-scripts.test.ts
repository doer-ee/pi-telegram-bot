import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launchAgentLabel = "com.doer.pi-telegram-bot";
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

describeIfDarwin("launch-agent scripts", () => {
	let tempHomeDir: string;

	beforeEach(async () => {
		tempHomeDir = await mkdtemp(join(tmpdir(), "pi-telegram-bot-launch-agent-"));
	});

	afterEach(async () => {
		await rm(tempHomeDir, { recursive: true, force: true });
	});

	it("renders launchd log paths under the user Library/Logs directory", async () => {
		const outputPath = join(tempHomeDir, "generated-launch-agent.plist");
		const expectedLogDir = join(tempHomeDir, "Library", "Logs", "pi-telegram-bot");

		await execFileAsync("bash", [join(repoRoot, "scripts", "generate-launch-agent-plist.sh"), outputPath], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: tempHomeDir,
			},
		});

		const plist = await readFile(outputPath, "utf8");

		expect(plist).toContain(`<string>${expectedLogDir}/stdout.log</string>`);
		expect(plist).toContain(`<string>${expectedLogDir}/stderr.log</string>`);
		expect(plist).toContain(`<string>${expectedLogDir}</string>`);
		expect(plist).not.toContain("/tmp/logs/launchd");
	});

	it("reports the same user log paths in service status output", async () => {
		const expectedPlistPath = join(tempHomeDir, "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
		const expectedStdoutLogPath = join(tempHomeDir, "Library", "Logs", "pi-telegram-bot", "stdout.log");
		const expectedStderrLogPath = join(tempHomeDir, "Library", "Logs", "pi-telegram-bot", "stderr.log");

		const { stdout } = await execFileAsync("bash", [join(repoRoot, "scripts", "status-launch-agent.sh")], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: tempHomeDir,
			},
		});

		expect(stdout).toContain(`Installed plist: ${expectedPlistPath}`);
		expect(stdout).toContain(`Stdout log: ${expectedStdoutLogPath}`);
		expect(stdout).toContain(`Stderr log: ${expectedStderrLogPath}`);
	});
});
