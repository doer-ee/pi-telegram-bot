export class BusySessionError extends Error {
	constructor() {
		super("A Pi run is already active. Abort it before sending another prompt or changing sessions or models.");
		this.name = "BusySessionError";
	}
}

export class NoSelectedSessionError extends Error {
	constructor() {
		super("No session is selected. Use /new, /sessions, or send a freeform message to create one.");
		this.name = "NoSelectedSessionError";
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

export class SelectedModelUnavailableError extends Error {
	constructor() {
		super("Selected model is no longer available.");
		this.name = "SelectedModelUnavailableError";
	}
}
