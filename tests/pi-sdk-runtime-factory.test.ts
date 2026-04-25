import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	createAgentSessionFromServicesMock,
	createAgentSessionRuntimeMock,
	createAgentSessionServicesMock,
	sessionManagerCreateMock,
	sessionManagerInMemoryMock,
	sessionManagerListMock,
	sessionManagerOpenMock,
	runSessionTitleRefinementWithTimeoutMock,
} = vi.hoisted(() => ({
	createAgentSessionFromServicesMock: vi.fn(),
	createAgentSessionRuntimeMock: vi.fn(),
	createAgentSessionServicesMock: vi.fn(),
	sessionManagerCreateMock: vi.fn(),
	sessionManagerInMemoryMock: vi.fn(),
	sessionManagerListMock: vi.fn(),
	sessionManagerOpenMock: vi.fn(),
	runSessionTitleRefinementWithTimeoutMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	createAgentSessionFromServices: createAgentSessionFromServicesMock,
	createAgentSessionRuntime: createAgentSessionRuntimeMock,
	createAgentSessionServices: createAgentSessionServicesMock,
	getAgentDir: () => "/default-agent-dir",
	SessionManager: {
		create: sessionManagerCreateMock,
		inMemory: sessionManagerInMemoryMock,
		list: sessionManagerListMock,
		open: sessionManagerOpenMock,
	},
}));

vi.mock("../src/pi/session-title-refinement.js", () => ({
	runSessionTitleRefinementWithTimeout: runSessionTitleRefinementWithTimeoutMock,
}));

import { PiSdkRuntimeFactory } from "../src/pi/pi-sdk-runtime-factory.js";

describe("PiSdkRuntimeFactory", () => {
	let consoleInfoMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoMock = vi.spyOn(console, "info").mockImplementation(() => undefined);

		const sessionManager = {
			getCwd: () => "/workspace",
		};
		sessionManagerCreateMock.mockReturnValue(sessionManager);
		sessionManagerOpenMock.mockReturnValue(sessionManager);
		sessionManagerInMemoryMock.mockReturnValue({ kind: "in-memory-session-manager" });
		sessionManagerListMock.mockResolvedValue([]);

		const runtimeSession = createRuntimeSession();
		createAgentSessionRuntimeMock.mockImplementation(async (createRuntimeFactory, options) => {
			await createRuntimeFactory({
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: undefined,
			});

			return {
				diagnostics: [],
				dispose: vi.fn(),
				newSession: vi.fn(),
				session: runtimeSession,
				switchSession: vi.fn(),
			};
		});

		createAgentSessionFromServicesMock.mockResolvedValue({
			session: {
				dispose: vi.fn(),
			},
		});
		runSessionTitleRefinementWithTimeoutMock.mockResolvedValue({
			status: "completed",
			candidateTitle: "refined title",
		});
	});

	afterEach(() => {
		consoleInfoMock.mockRestore();
	});

	it("#given a dedicated title model override #when runtime and refinement sessions are created #then only refinement receives that configured model", async () => {
		const mainModel = createModel({ provider: "openai", id: "gpt-5.4" });
		const titleModel = createModel({ provider: "openai", id: "gpt-5.4-mini" });

		setAvailableModels([mainModel, titleModel]);

		const factory = new PiSdkRuntimeFactory("/agent-dir", "openai/gpt-5.4-mini");

		await factory.createRuntime({ workspacePath: "/workspace" });
		await factory.refineSessionTitle({
			heuristicTitle: "Session title",
			prompt: "Help me debug the Telegram bot",
			timeoutMs: 100,
			workspacePath: "/workspace",
		});

		expect(createAgentSessionFromServicesMock).toHaveBeenCalledTimes(2);
		expect(createAgentSessionFromServicesMock.mock.calls[0]?.[0]?.model).toBeUndefined();
		expect(createAgentSessionFromServicesMock.mock.calls[1]?.[0]?.model).toBe(titleModel);
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement-model=openai/gpt-5.4-mini",
		);
	});

	it("#given the default title model is ambiguous across providers #when refinement runs #then it resolves deterministically without changing the main runtime path", async () => {
		const preferredDefaultModel = createModel({ provider: "openai", id: "gpt-5.4-mini" });
		const alternateDefaultModel = createModel({ provider: "openrouter", id: "gpt-5.4-mini" });

		setAvailableModels([alternateDefaultModel, preferredDefaultModel]);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await factory.createRuntime({ workspacePath: "/workspace" });
		await factory.refineSessionTitle({
			heuristicTitle: "Session title",
			prompt: "Help me debug the Telegram bot",
			timeoutMs: 100,
			workspacePath: "/workspace",
		});

		expect(createAgentSessionFromServicesMock).toHaveBeenCalledTimes(2);
		expect(createAgentSessionFromServicesMock.mock.calls[0]?.[0]?.model).toBeUndefined();
		expect(createAgentSessionFromServicesMock.mock.calls[1]?.[0]?.model).toBe(preferredDefaultModel);
	});

	it("#given a non-default bare title model override is ambiguous #when refinement runs #then it still rejects clearly", async () => {
		setAvailableModels([
			createModel({ provider: "alpha", id: "shared-model" }),
			createModel({ provider: "beta", id: "shared-model" }),
		]);

		const factory = new PiSdkRuntimeFactory("/agent-dir", "shared-model");

		await expect(
			factory.refineSessionTitle({
				heuristicTitle: "Session title",
				prompt: "Help me debug the Telegram bot",
				timeoutMs: 100,
				workspacePath: "/workspace",
			}),
		).rejects.toThrowError(
			'Configured title refinement model "shared-model" is ambiguous. Matches: alpha/shared-model, beta/shared-model',
		);
		expect(createAgentSessionFromServicesMock).not.toHaveBeenCalled();
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement unavailable final=\"Session title\"",
		);
	});

	it("#given a unique bare-id title model without configured auth #when refinement runs #then it fails cleanly during model resolution", async () => {
		const unauthenticatedModel = createModel({ provider: "openai", id: "unique-model" });

		setAvailableModels([unauthenticatedModel], {
			hasConfiguredAuth(model) {
				return model !== unauthenticatedModel;
			},
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir", "unique-model");

		await expect(
			factory.refineSessionTitle({
				heuristicTitle: "Session title",
				prompt: "Help me debug the Telegram bot",
				timeoutMs: 100,
				workspacePath: "/workspace",
			}),
		).rejects.toThrowError(
			'Configured title refinement model "unique-model" is missing auth configuration for openai/unique-model.',
		);
		expect(createAgentSessionFromServicesMock).not.toHaveBeenCalled();
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement unavailable final=\"Session title\"",
		);
	});

	it("#given the deterministic default title model lacks configured auth #when refinement runs #then it fails cleanly during model resolution", async () => {
		const preferredDefaultModel = createModel({ provider: "openai", id: "gpt-5.4-mini" });
		const alternateDefaultModel = createModel({ provider: "openrouter", id: "gpt-5.4-mini" });

		setAvailableModels([alternateDefaultModel, preferredDefaultModel], {
			hasConfiguredAuth(model) {
				return model !== preferredDefaultModel;
			},
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(
			factory.refineSessionTitle({
				heuristicTitle: "Session title",
				prompt: "Help me debug the Telegram bot",
				timeoutMs: 100,
				workspacePath: "/workspace",
			}),
		).rejects.toThrowError(
			'Configured title refinement model "gpt-5.4-mini" is missing auth configuration for openai/gpt-5.4-mini.',
		);
		expect(createAgentSessionFromServicesMock).not.toHaveBeenCalled();
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement unavailable final=\"Session title\"",
		);
	});

	it("#given a refinement timeout #when the dedicated title call runs too long #then it logs the timeout and keeps the heuristic title", async () => {
		setAvailableModels([createModel({ provider: "openai", id: "gpt-5.4-mini" })]);
		runSessionTitleRefinementWithTimeoutMock.mockResolvedValue({
			status: "timed_out",
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(
			factory.refineSessionTitle({
				heuristicTitle: "Session title",
				prompt: "Help me debug the Telegram bot",
				timeoutMs: 100,
				workspacePath: "/workspace",
			}),
		).resolves.toBeUndefined();
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement timed out final=\"Session title\"",
		);
	});

	it("#given a refinement runtime error #when the dedicated title call fails unexpectedly #then it logs the failure without exposing prompt text", async () => {
		setAvailableModels([createModel({ provider: "openai", id: "gpt-5.4-mini" })]);
		runSessionTitleRefinementWithTimeoutMock.mockRejectedValue(new Error("network down"));

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(
			factory.refineSessionTitle({
				heuristicTitle: "Session title",
				prompt: "Help me debug the Telegram bot",
				timeoutMs: 100,
				workspacePath: "/workspace",
			}),
		).rejects.toThrowError("network down");
		expect(consoleInfoMock).toHaveBeenCalledWith(
			"[pi-telegram-bot] session-title refinement failed final=\"Session title\"",
		);
	});
});

function setAvailableModels(
	availableModels: Model<Api>[],
	overrides?: {
		hasConfiguredAuth?: (model: Model<Api>) => boolean;
	},
): void {
	createAgentSessionServicesMock.mockResolvedValue({
		agentDir: "/agent-dir",
		cwd: "/workspace",
		diagnostics: [],
		modelRegistry: {
			find(provider: string, modelId: string) {
				return availableModels.find((model) => model.provider === provider && model.id === modelId);
			},
			getAvailable() {
				return availableModels;
			},
			hasConfiguredAuth(model: Model<Api>) {
				return overrides?.hasConfiguredAuth?.(model) ?? true;
			},
		},
	});
}

function createRuntimeSession() {
	return {
		abort: vi.fn(),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		isStreaming: false,
		sendUserMessage: vi.fn(),
		sessionFile: "/workspace/.pi/sessions/session.jsonl",
		sessionId: "session-1",
		sessionName: undefined,
		setSessionName: vi.fn(),
		subscribe: vi.fn(() => () => undefined),
	};
}

function createModel(overrides: Pick<Model<Api>, "id" | "provider">): Model<Api> {
	return {
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 128_000,
		cost: {
			cacheRead: 0,
			cacheWrite: 0,
			input: 0,
			output: 0,
		},
		id: overrides.id,
		input: ["text"],
		maxTokens: 16_384,
		name: overrides.id,
		provider: overrides.provider,
		reasoning: false,
	};
}
