import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
	type AppState,
	type AppStateStore,
	createEmptyAppState,
	type StoredBotOwnedSessionPin,
	type StoredRecentModel,
	type StoredSelectedSession,
} from "./app-state.js";

const StoredSelectedSessionSchema = z.object({
	path: z.string().min(1),
	sessionId: z.string().min(1),
	selectedAt: z.string().min(1),
});

const StoredBotOwnedSessionPinSchema = z.object({
	chatId: z.number().int(),
	messageId: z.number().int().positive(),
	sessionPath: z.string().min(1),
	text: z.string().min(1),
});

const StoredRecentModelSchema = z.object({
	provider: z.string().min(1),
	id: z.string().min(1),
});

const AppStateSchema = z.object({
	version: z.literal(1),
	workspacePath: z.string().min(1),
	selectedSession: StoredSelectedSessionSchema.optional(),
	botOwnedSessionPin: StoredBotOwnedSessionPinSchema.optional(),
	modelRecency: z.array(StoredRecentModelSchema).optional(),
});

export class FileAppStateStore implements AppStateStore {
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(private readonly statePath: string) {}

	async load(workspacePath: string): Promise<AppState> {
		try {
			const content = await readFile(this.statePath, "utf8");
			const parsed = AppStateSchema.parse(JSON.parse(content));
			if (parsed.workspacePath !== workspacePath) {
				return createEmptyAppState(workspacePath);
			}
			return parsed;
		} catch (error) {
			if (isMissingFileError(error)) {
				return createEmptyAppState(workspacePath);
			}
			throw new Error(`Failed to load app state from ${this.statePath}: ${formatError(error)}`);
		}
	}

	async saveSelectedSession(workspacePath: string, selectedSession: StoredSelectedSession): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			selectedSession,
		}));
	}

	async clearSelectedSession(workspacePath: string): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			selectedSession: undefined,
		}));
	}

	async saveBotOwnedSessionPin(workspacePath: string, botOwnedSessionPin: StoredBotOwnedSessionPin): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			botOwnedSessionPin,
		}));
	}

	async clearBotOwnedSessionPin(workspacePath: string): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			botOwnedSessionPin: undefined,
		}));
	}

	async saveModelRecency(workspacePath: string, modelRecency: StoredRecentModel[]): Promise<void> {
		await this.updateState(workspacePath, (state) => ({
			...state,
			modelRecency,
		}));
	}

	private async writeState(state: AppState): Promise<void> {
		const validated = AppStateSchema.parse(state);
		const tempPath = `${this.statePath}.tmp`;
		await mkdir(dirname(this.statePath), { recursive: true });
		await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await rename(tempPath, this.statePath);
	}

	private async updateState(
		workspacePath: string,
		update: (state: AppState) => AppState,
	): Promise<void> {
		const nextWrite = this.pendingWrite.catch(() => undefined).then(async () => {
			const currentState = await this.load(workspacePath);
			const nextState = update(currentState);
			await this.writeState(nextState);
		});

		this.pendingWrite = nextWrite;
		await nextWrite;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function formatError(error: unknown): string {
	if (error instanceof z.ZodError) {
		return error.issues.map((issue) => issue.message).join(", ");
	}
	return error instanceof Error ? error.message : String(error);
}
