export class BusySessionError extends Error {
	constructor() {
		super("A Pi run is already active. Abort it before sending another prompt or changing sessions or models.");
		this.name = "BusySessionError";
	}
}

export class NoSelectedSessionError extends Error {
	constructor() {
		super("No session is selected. Use /new, /sessions, or send a freeform message or supported upload to create one.");
		this.name = "NoSelectedSessionError";
	}
}

export class SessionNotFoundError extends Error {
	constructor(identifier: string) {
		super(`Session not found: ${identifier}`);
		this.name = "SessionNotFoundError";
	}
}

export class SelectedModelUnavailableError extends Error {
	constructor() {
		super("Selected model is no longer available.");
		this.name = "SelectedModelUnavailableError";
	}
}

export class InvalidSessionNameError extends Error {
	constructor() {
		super("Session name cannot be blank. Send a non-empty name or tap cancel.");
		this.name = "InvalidSessionNameError";
	}
}
