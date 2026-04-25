export class BusySessionError extends Error {
	constructor() {
		super("A Pi run is already active. Abort it before sending another prompt or switching sessions.");
		this.name = "BusySessionError";
	}
}

export class SessionNotFoundError extends Error {
	constructor(identifier: string) {
		super(`Session not found: ${identifier}`);
		this.name = "SessionNotFoundError";
	}
}

export class AmbiguousSessionReferenceError extends Error {
	constructor(identifier: string, matches: string[]) {
		super(`Session reference '${identifier}' is ambiguous. Matches: ${matches.join(", ")}`);
		this.name = "AmbiguousSessionReferenceError";
	}
}
