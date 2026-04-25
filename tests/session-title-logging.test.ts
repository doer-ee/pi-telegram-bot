import { afterEach, describe, expect, it, vi } from "vitest";
import {
	logHeuristicSessionTitle,
	logSessionTitleRefinementOutcome,
	sanitizeSessionTitleForLog,
} from "../src/session/session-title-logging.js";

describe("session-title-logging", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("#given a title with sensitive-looking tokens #when sanitizing for logs #then it redacts the token values but keeps the surrounding diagnostic context", () => {
		const secret = "sk-proj-AbCdEf1234567890XYZ987654321";
		const sanitizedTitle = sanitizeSessionTitleForLog(`Rotate OPENAI_API_KEY=${secret} tonight`);

		expect(sanitizedTitle).toBe("Rotate OPENAI_API_KEY=[secret] tonight");
		expect(sanitizedTitle).not.toContain(secret);
	});

	it("#given secret-like values in heuristic and refinement logs #when logging title diagnostics #then the raw values are never emitted", () => {
		const consoleInfoMock = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const secret = "ghp_1234567890abcdefghijklmnop";

		logHeuristicSessionTitle(`Share ${secret} with dev@example.com via https://example.com/reset?token=${secret}`);
		logSessionTitleRefinementOutcome({
			outcome: "rejected",
			finalTitle: `Bearer ${secret}`,
			candidateTitle: `Email dev@example.com and use ${secret}`,
		});

		const combinedLogs = consoleInfoMock.mock.calls.map(([line]) => String(line)).join("\n");

		expect(combinedLogs).not.toContain(secret);
		expect(combinedLogs).not.toContain("dev@example.com");
		expect(combinedLogs).not.toContain("https://example.com/reset?token=");
		expect(combinedLogs).toContain("[secret]");
		expect(combinedLogs).toContain("[email]");
		expect(combinedLogs).toContain("[url]");
	});
});
