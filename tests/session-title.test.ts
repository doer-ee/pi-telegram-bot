import { describe, expect, it } from "vitest";
import {
	buildSessionTitleRefinementPrompt,
	generateHeuristicSessionTitle,
	selectRefinedSessionTitle,
} from "../src/session/session-title.js";

describe("session-title", () => {
	describe("#given a first user prompt", () => {
		it("#when building a heuristic title #then it strips conversational lead-ins and keeps the title short", () => {
			expect(
				generateHeuristicSessionTitle(
					"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive",
				),
			).toBe("Debug the Telegram bot session naming after");
		});
	});

	describe("#given a refinement candidate", () => {
		it("#when the candidate is concise and more specific #then it replaces the heuristic title", () => {
			const refinedTitle = selectRefinedSessionTitle({
				prompt:
					"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive",
				heuristicTitle: "Debug the Telegram bot session naming after",
				candidateTitle: "Telegram naming after /new",
			});

			expect(refinedTitle).toBe("Telegram naming after /new");
		});

		it("#when the candidate is generic or weak #then it keeps the heuristic title", () => {
			const refinedTitle = selectRefinedSessionTitle({
				prompt:
					"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive",
				heuristicTitle: "Debug the Telegram bot session naming after",
				candidateTitle: "New chat",
			});

			expect(refinedTitle).toBeUndefined();
		});
	});

	describe("#given a refinement prompt", () => {
		it("#when the prompt is complex #then it includes the heuristic title and original request", () => {
			const prompt =
				"Please help me debug the Telegram bot session naming after /new when the first user prompt should stay responsive";
			const heuristicTitle = generateHeuristicSessionTitle(prompt);

			expect(buildSessionTitleRefinementPrompt(prompt, heuristicTitle)).toContain(heuristicTitle);
			expect(buildSessionTitleRefinementPrompt(prompt, heuristicTitle)).toContain(prompt);
		});
	});
});
