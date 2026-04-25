import { describe, expect, it } from "vitest";
import { runSessionTitleRefinementWithTimeout } from "../src/pi/session-title-refinement.js";

describe("runSessionTitleRefinementWithTimeout", () => {
	it("#given a hanging refinement session #when timeout elapses #then it aborts, disposes, and returns undefined", async () => {
		const session = new MockSession();
		session.sendUserMessageHandler = async () => await session.hangingPrompt.promise;

		const result = await runSessionTitleRefinementWithTimeout({
			session,
			prompt: "Generate a short title",
			timeoutMs: 20,
		});

		expect(result).toEqual({
			status: "timed_out",
		});
		expect(session.abortCallCount).toBe(1);
		expect(session.disposeCallCount).toBe(1);
		expect(session.boundExtensions).toBe(1);

		session.hangingPrompt.reject(new Error("late failure after timeout"));
		await flushAsyncWork();
	});

	it("#given a successful refinement session #when it completes before timeout #then it returns the assistant text and still disposes", async () => {
		const session = new MockSession();
		session.lastAssistantText = "Telegram naming after /new";

		const result = await runSessionTitleRefinementWithTimeout({
			session,
			prompt: "Generate a short title",
			timeoutMs: 100,
		});

		expect(result).toEqual({
			status: "completed",
			candidateTitle: "Telegram naming after /new",
		});
		expect(session.abortCallCount).toBe(0);
		expect(session.disposeCallCount).toBe(1);
		expect(session.sentMessages).toEqual(["Generate a short title"]);
	});
});

class MockSession {
	readonly sentMessages: string[] = [];
	readonly hangingPrompt = createDeferred<void>();
	lastAssistantText: string | undefined;
	abortCallCount = 0;
	disposeCallCount = 0;
	boundExtensions = 0;
	sendUserMessageHandler: ((content: string) => Promise<void>) | undefined;

	async bindExtensions(_: object): Promise<void> {
		this.boundExtensions += 1;
	}

	async sendUserMessage(content: string): Promise<void> {
		this.sentMessages.push(content);
		if (this.sendUserMessageHandler) {
			await this.sendUserMessageHandler(content);
		}
	}

	getLastAssistantText(): string | undefined {
		return this.lastAssistantText;
	}

	async abort(): Promise<void> {
		this.abortCallCount += 1;
	}

	dispose(): void {
		this.disposeCallCount += 1;
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
