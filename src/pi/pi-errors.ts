export class ModelNotAvailableError extends Error {
	constructor(identifier: string) {
		super(`Model not available for this session: ${identifier}`);
		this.name = "ModelNotAvailableError";
	}
}
