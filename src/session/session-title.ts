const MAX_SESSION_TITLE_LENGTH = 48;
const MAX_SESSION_TITLE_WORDS = 7;

const LEAD_IN_PATTERNS = [
	/^(?:please\s+)+/i,
	/^(?:can|could|would|will)\s+you\s+/i,
	/^help\s+me\s+(?:to\s+)?/i,
	/^i\s+(?:need|want|would\s+like)\s+(?:you\s+)?to\s+/i,
	/^let'?s\s+/i,
];

const GENERIC_TITLES = new Set([
	"chat",
	"conversation",
	"general help",
	"help",
	"new chat",
	"new conversation",
	"new session",
	"question",
	"request",
	"session",
	"session title",
	"task",
	"title",
	"untitled",
	"user request",
]);

export interface SessionTitleRefinementSelection {
	prompt: string;
	heuristicTitle: string;
	candidateTitle: string;
}

export function generateHeuristicSessionTitle(prompt: string): string {
	const cleanedPrompt = cleanPromptText(prompt);
	const withoutLeadIn = stripLeadIn(cleanedPrompt);
	const source = withoutLeadIn.length > 0 ? withoutLeadIn : cleanedPrompt;
	const cappedWords = limitWords(source, MAX_SESSION_TITLE_WORDS);
	const shortened = smartTruncate(cappedWords, MAX_SESSION_TITLE_LENGTH);
	return normalizeSentenceStart(shortened.length > 0 ? shortened : "New session");
}

export function selectRefinedSessionTitle(selection: SessionTitleRefinementSelection): string | undefined {
	return normalizeCandidateSessionTitle(selection.candidateTitle);
}

export function buildSessionTitleRefinementPrompt(prompt: string, heuristicTitle: string): string {
	return [
		"Generate a concise session title for a Telegram chat thread.",
		"Rules:",
		"- return title text only",
		"- keep it between 2 and 6 words when possible",
		`- keep it under ${MAX_SESSION_TITLE_LENGTH} characters`,
		"- no quotes, labels, markdown, or trailing punctuation",
		"- preserve important filenames, commands, and technical terms",
		"- prefer a sharper title only if it is clearly better than the heuristic",
		"",
		`Heuristic title: ${heuristicTitle}`,
		"User request:",
		prompt.trim(),
	].join("\n");
}

function normalizeCandidateSessionTitle(candidate: string): string | undefined {
	const firstLine = candidate
		.trim()
		.replace(/^title\s*:\s*/i, "")
		.split(/\r?\n/u)
		.find((line) => line.trim().length > 0)
		?.trim();

	if (!firstLine) {
		return undefined;
	}

	const unquoted = firstLine.replace(/^["'`]+|["'`]+$/g, "");
	const shortenedSentence = unquoted.split(/(?<=[.!?])\s+/u)[0]?.trim() ?? "";
	const collapsed = shortenedSentence.replace(/\s+/g, " ").replace(/[.!?,:;]+$/u, "").trim();
	if (collapsed.length === 0) {
		return undefined;
	}

	const normalized = smartTruncate(collapsed, MAX_SESSION_TITLE_LENGTH);
	if (isWeakSessionTitle(normalized)) {
		return undefined;
	}

	return normalizeSentenceStart(normalized);
}

function isWeakSessionTitle(title: string): boolean {
	const normalized = title.trim().toLowerCase();
	if (normalized.length < 4) {
		return true;
	}

	if (!/[a-z0-9]/iu.test(normalized)) {
		return true;
	}

	if (GENERIC_TITLES.has(normalized)) {
		return true;
	}

	return countWords(normalized) > MAX_SESSION_TITLE_WORDS + 1;
}

function cleanPromptText(prompt: string): string {
	return prompt
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/\[(.*?)\]\((.*?)\)/gu, "$1")
		.replace(/^[>#*\-+]+\s*/gmu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function stripLeadIn(prompt: string): string {
	let nextPrompt = prompt.trim();
	let replaced = true;
	while (replaced) {
		replaced = false;
		for (const pattern of LEAD_IN_PATTERNS) {
			const updatedPrompt = nextPrompt.replace(pattern, "").trim();
			if (updatedPrompt !== nextPrompt) {
				nextPrompt = updatedPrompt;
				replaced = true;
			}
		}
	}
	return nextPrompt;
}

function limitWords(text: string, maxWords: number): string {
	const words = text.split(/\s+/u).filter((word) => word.length > 0);
	if (words.length <= maxWords) {
		return text;
	}
	return words.slice(0, maxWords).join(" ");
}

function smartTruncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	const sliced = text.slice(0, maxLength - 3);
	const lastSpace = sliced.lastIndexOf(" ");
	const nextText = lastSpace >= Math.floor(maxLength / 2) ? sliced.slice(0, lastSpace) : sliced;
	return `${nextText.trim()}...`;
}

function normalizeSentenceStart(text: string): string {
	return /^[a-z]/u.test(text) ? `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}` : text;
}

function countWords(text: string): number {
	return text.split(/\s+/u).filter((word) => word.length > 0).length;
}
