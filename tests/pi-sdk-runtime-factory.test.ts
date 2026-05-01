import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readFileMock, rmMock } = vi.hoisted(() => ({
	readFileMock: vi.fn(),
	rmMock: vi.fn(),
}));

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

vi.mock("node:fs/promises", () => ({
	readFile: readFileMock,
	rm: rmMock,
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

let currentAvailableModels: Model<Api>[] = [];
let currentHasConfiguredAuth: (model: Model<Api>) => boolean = () => true;

describe("PiSdkRuntimeFactory", () => {
	let consoleInfoMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		currentAvailableModels = [];
		currentHasConfiguredAuth = () => true;
		consoleInfoMock = vi.spyOn(console, "info").mockImplementation(() => undefined);

		sessionManagerCreateMock.mockImplementation((cwd: string) => ({
			getCwd: () => cwd,
		}));
		sessionManagerOpenMock.mockImplementation(
			(_path: string, _sessionDir?: string, cwdOverride?: string) => ({
				getCwd: () => cwdOverride ?? "/workspace",
			}),
		);
		sessionManagerInMemoryMock.mockReturnValue({ kind: "in-memory-session-manager" });
		sessionManagerListMock.mockResolvedValue([]);
		readFileMock.mockResolvedValue("");
		setAvailableModels([]);

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
				newSession: vi.fn().mockResolvedValue({ cancelled: false }),
				session: runtimeSession,
				switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
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

	it("#given a restored selected session with a stale header cwd #when creating the runtime #then it reapplies the configured workspace path", async () => {
		sessionManagerOpenMock.mockImplementation(
			(path: string, _sessionDir?: string, cwdOverride?: string) => ({
				getCwd: () => cwdOverride ?? `/stale-for-${path}`,
			}),
		);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await factory.createRuntime({
			workspacePath: "/workspace",
			selectedSessionPath: "/stale/session.jsonl",
		});

		expect(sessionManagerOpenMock).toHaveBeenCalledWith(
			"/stale/session.jsonl",
			undefined,
			"/workspace",
		);
		expect(createAgentSessionRuntimeMock).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				cwd: "/workspace",
			}),
		);
	});

	it("#given a runtime restored from a stale-cwd session #when a later new session uses that runtime #then it stays anchored to the configured workspace", async () => {
		let observedRuntimeCwd: string | undefined;
		createAgentSessionRuntimeMock.mockImplementation(async (createRuntimeFactory, options) => {
			await createRuntimeFactory({
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: undefined,
			});

			return {
				diagnostics: [],
				dispose: vi.fn(),
				newSession: vi.fn(async () => {
					observedRuntimeCwd = options.sessionManager.getCwd();
					return { cancelled: false };
				}),
				session: createRuntimeSession(),
				switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
			};
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir");
		const runtime = await factory.createRuntime({
			workspacePath: "/workspace",
			selectedSessionPath: "/stale/session.jsonl",
		});

		await runtime.newSession();

		expect(observedRuntimeCwd).toBe("/workspace");
	});

	it("#given an already-running runtime #when switching sessions #then it keeps the configured workspace override", async () => {
		const switchSessionMock = vi.fn().mockResolvedValue({ cancelled: false });
		createAgentSessionRuntimeMock.mockImplementation(async (createRuntimeFactory, options) => {
			await createRuntimeFactory({
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: undefined,
			});

			return {
				diagnostics: [],
				dispose: vi.fn(),
				newSession: vi.fn().mockResolvedValue({ cancelled: false }),
				session: createRuntimeSession(),
				switchSession: switchSessionMock,
			};
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir");
		const runtime = await factory.createRuntime({ workspacePath: "/workspace" });

		await runtime.switchSession("/workspace/.pi/sessions/other-session.jsonl");

		expect(switchSessionMock).toHaveBeenCalledWith(
			"/workspace/.pi/sessions/other-session.jsonl",
			{ cwdOverride: "/workspace" },
		);
	});

	it("#given a runtime session with an active conversation model #when creating the runtime #then the session adapter exposes that actual model", async () => {
		const activeModel = createModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
		const titleModel = createModel({ provider: "openai", id: "gpt-5.4-mini" });

		setAvailableModels([activeModel, titleModel]);
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
				session: createRuntimeSession({ model: activeModel }),
				switchSession: vi.fn(),
			};
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir", "openai/gpt-5.4-mini");
		const runtime = await factory.createRuntime({ workspacePath: "/workspace" });

		expect(runtime.session.activeModel).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		});
	});

	it("#given auth-configured available models #when listing and changing the current session model #then it uses the runtime model registry and AgentSession.setModel", async () => {
		const currentModel = createModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
		const nextModel = createModel({ provider: "openai", id: "gpt-5.4" });
		const unauthenticatedModel = createModel({ provider: "openrouter", id: "gpt-5.4" });

		setAvailableModels([currentModel, nextModel, unauthenticatedModel], {
			hasConfiguredAuth(model) {
				return model !== unauthenticatedModel;
			},
		});

		const runtimeSession = createRuntimeSession({ model: currentModel });
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

		const factory = new PiSdkRuntimeFactory("/agent-dir");
		const runtime = await factory.createRuntime({ workspacePath: "/workspace" });

		await expect(runtime.session.listAvailableModels()).resolves.toEqual([
			{ provider: "anthropic", id: "claude-sonnet-4-5" },
			{ provider: "openai", id: "gpt-5.4" },
		]);

		await runtime.session.setActiveModel({ provider: "openai", id: "gpt-5.4" });

		expect(runtimeSession.setModel).toHaveBeenCalledWith(nextModel);
		expect(runtime.session.activeModel).toEqual({ provider: "openai", id: "gpt-5.4" });
	});

	it("#given a model that is missing or no longer auth-configured #when changing the current session model #then it fails clearly", async () => {
		const currentModel = createModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
		const unavailableModel = createModel({ provider: "openrouter", id: "gpt-5.4" });

		setAvailableModels([currentModel, unavailableModel], {
			hasConfiguredAuth(model) {
				return model !== unavailableModel;
			},
		});

		const factory = new PiSdkRuntimeFactory("/agent-dir");
		const runtime = await factory.createRuntime({ workspacePath: "/workspace" });

		await expect(
			runtime.session.setActiveModel({ provider: "openrouter", id: "gpt-5.4" }),
		).rejects.toThrowError("Model not available for this session: openrouter/gpt-5.4");
	});

	it("#given persisted sessions #when listing sessions #then it leaves the broad SessionManager listing untouched", async () => { sessionManagerListMock.mockResolvedValue([
			{
				path: "/workspace/.pi/sessions/session.jsonl",
				id: "session-1",
				cwd: "/workspace",
				name: "Prompt counting",
				created: new Date("2026-04-26T14:00:00.000Z"),
				modified: new Date("2026-04-26T14:05:00.000Z"),
				messageCount: 5,
				firstMessage: "first user prompt",
				allMessagesText: "first user prompt assistant reply follow-up",
			},
		]);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.listSessions("/workspace")).resolves.toEqual([
			{
				path: "/workspace/.pi/sessions/session.jsonl",
				id: "session-1",
				cwd: "/workspace",
				name: "Prompt counting",
				created: new Date("2026-04-26T14:00:00.000Z"),
				modified: new Date("2026-04-26T14:05:00.000Z"),
				messageCount: 5,
				firstMessage: "first user prompt",
				allMessagesText: "first user prompt assistant reply follow-up",
			},
		]);
		expect(readFileMock).not.toHaveBeenCalled(); });

	it("#given workspace-scoped persisted sessions #when clearing all sessions #then it deletes only those session files", async () => {
		sessionManagerListMock.mockResolvedValue([
			{
				path: "/workspace/.pi/sessions/session-a.jsonl",
				id: "session-a",
				cwd: "/workspace",
				name: "Alpha",
				created: new Date("2026-04-26T14:00:00.000Z"),
				modified: new Date("2026-04-26T14:05:00.000Z"),
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			},
			{
				path: "/workspace/.pi/sessions/session-b.jsonl",
				id: "session-b",
				cwd: "/workspace",
				name: "Beta",
				created: new Date("2026-04-26T15:00:00.000Z"),
				modified: new Date("2026-04-26T15:05:00.000Z"),
				messageCount: 2,
				firstMessage: "second",
				allMessagesText: "second",
			},
		]);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.deleteAllSessions("/workspace")).resolves.toBeUndefined();
		expect(rmMock).toHaveBeenCalledTimes(2);
		expect(rmMock).toHaveBeenNthCalledWith(1, "/workspace/.pi/sessions/session-a.jsonl", { force: true });
		expect(rmMock).toHaveBeenNthCalledWith(2, "/workspace/.pi/sessions/session-b.jsonl", { force: true });
	});

	it("#given a listed session outside the workspace #when clearing all sessions #then it fails closed before deleting", async () => {
		sessionManagerListMock.mockResolvedValue([
			{
				path: "/other-workspace/.pi/sessions/session-a.jsonl",
				id: "session-a",
				cwd: "/other-workspace",
				name: "Alpha",
				created: new Date("2026-04-26T14:00:00.000Z"),
				modified: new Date("2026-04-26T14:05:00.000Z"),
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			},
		]);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.deleteAllSessions("/workspace")).rejects.toThrowError(
			"Refusing to delete session outside the configured workspace: /other-workspace/.pi/sessions/session-a.jsonl",
		);
		expect(rmMock).not.toHaveBeenCalled();
	});

	it("#given persisted session entries with assistant and user messages #when requesting the selected-session prompt count #then it counts only real persisted user message entries", async () => {
		readFileMock.mockResolvedValue([
			JSON.stringify({
				type: "session",
				id: "session-1",
				timestamp: "2026-04-26T14:00:00.000Z",
				cwd: "/workspace",
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-04-26T14:00:01.000Z",
				message: { role: "user", content: "first user prompt" },
			}),
			JSON.stringify({
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-04-26T14:00:02.000Z",
				message: { role: "assistant", content: "assistant reply" },
			}),
			JSON.stringify({
				type: "custom_message",
				customType: "note",
				content: "ignored",
				display: true,
				id: "entry-3",
				parentId: "entry-2",
				timestamp: "2026-04-26T14:00:03.000Z",
			}),
			JSON.stringify({
				type: "message",
				id: "entry-4",
				parentId: "entry-3",
				timestamp: "2026-04-26T14:00:04.000Z",
				message: { role: "user", content: [{ type: "text", text: "follow-up" }] },
			}),
		].join("\n"));

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.getPersistedUserPromptCount("/workspace/.pi/sessions/session.jsonl")).resolves.toBe(2);
		expect(readFileMock).toHaveBeenCalledWith("/workspace/.pi/sessions/session.jsonl", "utf8");
	});

	it("#given persisted assistant replies in session history #when requesting the last assistant reply #then it returns the final persisted assistant text only", async () => {
		readFileMock.mockResolvedValue([
			JSON.stringify({
				type: "session",
				id: "session-1",
				timestamp: "2026-04-26T14:00:00.000Z",
				cwd: "/workspace",
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-04-26T14:00:01.000Z",
				message: { role: "assistant", content: "first reply" },
			}),
			JSON.stringify({
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-04-26T14:00:02.000Z",
				message: { role: "user", content: "follow-up" },
			}),
			JSON.stringify({
				type: "message",
				id: "entry-3",
				parentId: "entry-2",
				timestamp: "2026-04-26T14:00:03.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "text", text: " reply" }] },
			}),
		].join("\n"));

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.getPersistedLastAssistantReply("/workspace/.pi/sessions/session.jsonl")).resolves.toBe("final reply");
	});

	it("#given an unreadable selected session path #when requesting the prompt count #then it degrades safely instead of throwing", async () => {
		readFileMock.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.getPersistedUserPromptCount("/workspace/.pi/sessions/session.jsonl")).resolves.toBeUndefined();
		await expect(factory.getPersistedLastAssistantReply("/workspace/.pi/sessions/session.jsonl")).resolves.toBeUndefined();
	});

	it("#given a corrupt selected session file #when requesting the prompt count #then it degrades safely instead of guessing", async () => {
		readFileMock.mockResolvedValue(
			`${JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-04-26T14:00:00.000Z", cwd: "/workspace" })}\nnot-json`,
		);

		const factory = new PiSdkRuntimeFactory("/agent-dir");

		await expect(factory.getPersistedUserPromptCount("/workspace/.pi/sessions/session.jsonl")).resolves.toBeUndefined();
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
	currentAvailableModels = availableModels;
	currentHasConfiguredAuth = overrides?.hasConfiguredAuth ?? (() => true);

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
				return currentHasConfiguredAuth(model);
			},
		},
	});
}

function createRuntimeSession(overrides?: { model?: Model<Api> | undefined }) {
	const runtimeSession = {
		abort: vi.fn(),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		isStreaming: false,
		modelRegistry: {
			find(provider: string, modelId: string) {
				return currentAvailableModels.find((model) => model.provider === provider && model.id === modelId);
			},
			getAvailable() {
				return currentAvailableModels.filter((model) => currentHasConfiguredAuth(model));
			},
			hasConfiguredAuth(model: Model<Api>) {
				return currentHasConfiguredAuth(model);
			},
		},
		model: overrides?.model,
		sendUserMessage: vi.fn(),
		sessionFile: "/workspace/.pi/sessions/session.jsonl",
		sessionId: "session-1",
		sessionName: undefined,
		setModel: vi.fn(async (model: Model<Api>) => {
			runtimeSession.model = model;
		}),
		setSessionName: vi.fn(),
		subscribe: vi.fn(() => () => undefined),
	};

	return runtimeSession;
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
