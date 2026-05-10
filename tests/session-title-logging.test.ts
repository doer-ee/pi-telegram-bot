import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getSessionTitleRefinementOutcomeLogEmission,
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
		const emission = getSessionTitleRefinementOutcomeLogEmission({
			outcome: "timed out",
			finalTitle: `Bearer ${secret}`,
		});

		const combinedLogs = [consoleInfoMock.mock.calls[0]?.[0], emission?.message].join("\n");

		expect(combinedLogs).not.toContain(secret);
		expect(combinedLogs).not.toContain("dev@example.com");
		expect(combinedLogs).not.toContain("https://example.com/reset?token=");
		expect(combinedLogs).toContain("[secret]");
		expect(combinedLogs).toContain("[email]");
		expect(combinedLogs).toContain("[url]");
	});

	it("#given routine and degraded refinement outcomes #when logging the outcome #then routine results disappear from the emitted service log surface while degraded ones still emit", () => {
		expect(
			getSessionTitleRefinementOutcomeLogEmission({
				outcome: "accepted",
				finalTitle: "Accepted title",
			}),
		).toBeUndefined();
		expect(
			getSessionTitleRefinementOutcomeLogEmission({
				outcome: "rejected",
				finalTitle: "Heuristic title",
				candidateTitle: "Weak title",
			}),
		).toBeUndefined();
		expect(
			getSessionTitleRefinementOutcomeLogEmission({
				outcome: "timed out",
				finalTitle: "Heuristic title",
			}),
		).toEqual({
			target: "default-service-log-stderr",
			severity: "warning",
			message: '[pi-telegram-bot] session-title refinement timed out final="Heuristic title"',
		});
		expect(
			getSessionTitleRefinementOutcomeLogEmission({
				outcome: "unavailable",
				finalTitle: "Heuristic title",
			}),
		).toEqual({
			target: "default-service-log-stderr",
			severity: "warning",
			message: '[pi-telegram-bot] session-title refinement unavailable final="Heuristic title"',
		});
		expect(
			getSessionTitleRefinementOutcomeLogEmission({
				outcome: "failed",
				finalTitle: "Heuristic title",
			}),
		).toEqual({
			target: "default-service-log-stderr",
			severity: "error",
			message: '[pi-telegram-bot] session-title refinement failed final="Heuristic title"',
		});
	});

	it("#given emitted refinement outcomes #when writing them through the logger #then only degraded outcomes hit the default service log surface", () => {
		const consoleWarnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);

		logSessionTitleRefinementOutcome({
			outcome: "accepted",
			finalTitle: "Accepted title",
		});
		logSessionTitleRefinementOutcome({
			outcome: "rejected",
			finalTitle: "Heuristic title",
			candidateTitle: "Weak title",
		});
		logSessionTitleRefinementOutcome({
			outcome: "timed out",
			finalTitle: "Heuristic title",
		});
		logSessionTitleRefinementOutcome({
			outcome: "failed",
			finalTitle: "Heuristic title",
		});

		expect(consoleWarnMock.mock.calls).toEqual([
			['[pi-telegram-bot] session-title refinement timed out final="Heuristic title"'],
		]);
		expect(consoleErrorMock.mock.calls).toEqual([
			['[pi-telegram-bot] session-title refinement failed final="Heuristic title"'],
		]);
	});
});
