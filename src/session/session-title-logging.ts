const SESSION_TITLE_LOG_PREFIX = "[pi-telegram-bot] session-title";
const URL_PATTERN = /https?:\/\/\S+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const BEARER_PATTERN = /\bBearer\s+[^\s]+/giu;
const ASSIGNMENT_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]{1,63})=([^\s]+)/gu;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|pwd|auth|credential|cookie|session|private[_-]?key)/iu;
const WRAPPED_TOKEN_PATTERN = /^(?<prefix>[^\p{L}\p{N}\[]*)(?<core>.*?)(?<suffix>[^\p{L}\p{N}\]]*)$/u;
const SECRET_TOKEN_PATTERNS = [
	/^(?:sk|rk|pk)-[A-Za-z0-9-]{10,}$/u,
	/^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}$/u,
	/^github_pat_[A-Za-z0-9_]{10,}$/u,
	/^xox[baprs]-[A-Za-z0-9-]{10,}$/u,
	/^AKIA[0-9A-Z]{16}$/u,
	/^AIza[0-9A-Za-z\-_]{20,}$/u,
	/^ya29\.[0-9A-Za-z\-_]+$/u,
	/^eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+(?:\.[A-Za-z0-9_=-]+)?$/u,
	/^[A-Fa-f0-9]{32,}$/u,
];

type SessionTitleRefinementOutcome = "accepted" | "rejected" | "unavailable" | "timed out" | "failed";

export function logHeuristicSessionTitle(title: string): void {
	console.info(`${SESSION_TITLE_LOG_PREFIX} heuristic=${formatTitleForLog(title)}`);
}

export function logResolvedSessionTitleRefinementModel(provider: string, modelId: string): void {
	console.info(`${SESSION_TITLE_LOG_PREFIX} refinement-model=${provider}/${modelId}`);
}

export function logSessionTitleRefinementOutcome(options: {
	outcome: SessionTitleRefinementOutcome;
	finalTitle: string;
	candidateTitle?: string;
}): void {
	const fragments = [
		`${SESSION_TITLE_LOG_PREFIX} refinement ${options.outcome}`,
		`final=${formatTitleForLog(options.finalTitle)}`,
	];

	if (options.candidateTitle) {
		fragments.push(`candidate=${formatTitleForLog(options.candidateTitle)}`);
	}

	console.info(fragments.join(" "));
}

export function sanitizeSessionTitleForLog(title: string): string {
	const normalizedTitle = title.trim().replace(/\s+/gu, " ");
	if (normalizedTitle.length === 0) {
		return "[empty]";
	}

	const redactedText = normalizedTitle
		.replace(BEARER_PATTERN, "Bearer [secret]")
		.replace(URL_PATTERN, "[url]")
		.replace(EMAIL_PATTERN, "[email]")
		.replace(ASSIGNMENT_PATTERN, (_match, key: string, value: string) => {
			if (looksSensitiveKey(key) || looksSensitiveToken(value)) {
				return `${key}=[secret]`;
			}

			return `${key}=${sanitizeWrappedToken(value)}`;
		});

	return redactedText
		.split(" ")
		.map((token) => sanitizeWrappedToken(token))
		.join(" ");
}

function formatTitleForLog(title: string): string {
	return JSON.stringify(sanitizeSessionTitleForLog(title));
}

function sanitizeWrappedToken(token: string): string {
	if (
		token.length === 0 ||
		token.startsWith("[") ||
		token.includes("[secret]") ||
		token.includes("[url]") ||
		token.includes("[email]") ||
		!token.match(/[\p{L}\p{N}]/u)
	) {
		return token;
	}

	const match = token.match(WRAPPED_TOKEN_PATTERN);
	const prefix = match?.groups?.prefix ?? "";
	const core = match?.groups?.core ?? token;
	const suffix = match?.groups?.suffix ?? "";

	if (core.length === 0) {
		return token;
	}

	return looksSensitiveToken(core) ? `${prefix}[secret]${suffix}` : token;
}

function looksSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key);
}

function looksSensitiveToken(token: string): boolean {
	if (SECRET_TOKEN_PATTERNS.some((pattern) => pattern.test(token))) {
		return true;
	}

	const hasLower = /[a-z]/u.test(token);
	const hasUpper = /[A-Z]/u.test(token);
	const hasDigit = /\d/u.test(token);
	const hasSymbol = /[-_=+/]/u.test(token);
	const hasMultipleCharacterClasses = [hasLower || hasUpper, hasDigit, hasSymbol].filter(Boolean).length >= 2;

	return token.length >= 24
		? hasMultipleCharacterClasses
		: token.length >= 16 && hasLower && hasUpper && hasDigit;
}
