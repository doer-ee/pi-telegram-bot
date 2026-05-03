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

		it("#when the candidate is usable even without matching prompt keywords #then it still replaces the heuristic title", () => {
			const refinedTitle = selectRefinedSessionTitle({
				prompt: "Please help me figure out whether I need an umbrella this weekend in Chicago and what the temperature swing looks like",
				heuristicTitle: "Figure out whether I need an umbrella this",
				candidateTitle: "Pack layers and rain gear",
			});

			expect(refinedTitle).toBe("Pack layers and rain gear");
		});

		it("#when the candidate matches the heuristic exactly #then it is still accepted as the usable AI title", () => {
			const refinedTitle = selectRefinedSessionTitle({
				prompt: "Please help me draft a release checklist for the Pi Telegram bot",
				heuristicTitle: "Release checklist for the Pi Telegram bot",
				candidateTitle: "Release checklist for the Pi Telegram bot",
			});

			expect(refinedTitle).toBe("Release checklist for the Pi Telegram bot");
		});

		it("#when the candidate is a usable Chinese title #then it replaces the heuristic title", () => {
			const refinedTitle = selectRefinedSessionTitle({
				prompt: "请帮我排查 Telegram 机器人在 /new 之后的会话命名问题，并确保首条消息保持响应迅速",
				heuristicTitle: "排查 Telegram 机器人会话命名问题",
				candidateTitle: "首次响应 UX 优化",
			});

			expect(refinedTitle).toBe("首次响应 UX 优化");
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
