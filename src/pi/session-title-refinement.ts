export interface SessionTitleRefinementSession {
	bindExtensions(bindings: object): Promise<void>;
	sendUserMessage(content: string): Promise<void>;
	getLastAssistantText(): string | undefined;
	abort(): Promise<void>;
	dispose(): void;
}

export type SessionTitleRefinementRunResult =
	| {
		status: "completed";
		candidateTitle: string | undefined;
	}
	| {
		status: "timed_out";
	};

export async function runSessionTitleRefinementWithTimeout(options: {
	session: SessionTitleRefinementSession;
	prompt: string;
	timeoutMs: number;
}): Promise<SessionTitleRefinementRunResult> {
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;

	const refinementPromise = (async () => {
		await options.session.bindExtensions({});
		await options.session.sendUserMessage(options.prompt);
		return {
			status: "completed" as const,
			candidateTitle: options.session.getLastAssistantText()?.trim(),
		};
	})();

	const observedRefinementPromise = refinementPromise.catch((error: unknown) => {
		if (timedOut) {
			return {
				status: "timed_out" as const,
			};
		}
		throw error;
	});

	const timeoutPromise = new Promise<SessionTitleRefinementRunResult>((resolve) => {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			void options.session.abort().catch(() => undefined);
			resolve({
				status: "timed_out",
			});
		}, options.timeoutMs);
	});

	try {
		return await Promise.race([observedRefinementPromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
		safeDisposeSession(options.session);
	}
}

function safeDisposeSession(session: SessionTitleRefinementSession): void {
	try {
		session.dispose();
	} catch {
		return;
	}
}
