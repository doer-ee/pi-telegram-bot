const COMPLETE_FENCED_CODE_BLOCK_PATTERN = /```[^\n`]*\n([\s\S]*?)```/g;
const TELEGRAM_MARKDOWN_V2_ESCAPE_PATTERN = /([_*\[\]()~`>#+\-=|{}.!\\])/g;
const TELEGRAM_MARKDOWN_V2_CODE_ESCAPE_PATTERN = /([`\\])/g;
const PLACEHOLDER_PATTERN = /\u0000(\d+)\u0000/g;

export function formatTelegramMarkdown(text: string): string {
	const normalizedText = text.replace(/\r\n?/g, "\n");
	let formattedText = "";
	let lastIndex = 0;

	for (const match of normalizedText.matchAll(COMPLETE_FENCED_CODE_BLOCK_PATTERN)) {
		const matchIndex = match.index ?? 0;
		formattedText += formatTelegramMarkdownText(normalizedText.slice(lastIndex, matchIndex));
		formattedText += formatTelegramCodeBlock(match[1] ?? "");
		lastIndex = matchIndex + match[0].length;
	}

	formattedText += formatTelegramMarkdownText(normalizedText.slice(lastIndex));
	return formattedText;
}

function formatTelegramCodeBlock(code: string): string {
	const codeWithTrailingNewline = code.endsWith("\n") ? code : `${code}\n`;
	return `\`\`\`\n${escapeTelegramMarkdownV2Code(codeWithTrailingNewline)}\`\`\``;
}

function formatTelegramMarkdownText(text: string): string {
	return text.split("\n").map((line) => formatTelegramMarkdownLine(line)).join("\n");
}

function formatTelegramMarkdownLine(line: string): string {
	if (line.length === 0) {
		return line;
	}

	const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+)$/);
	if (headingMatch) {
		const indentation = headingMatch[1] ?? "";
		const content = headingMatch[2];
		if (content === undefined) {
			return formatTelegramInlineMarkdown(line);
		}
		return `${indentation}*${escapeTelegramMarkdownV2Text(content.trim())}*`;
	}

	const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
	if (bulletMatch) {
		const indentation = bulletMatch[1] ?? "";
		const content = bulletMatch[2];
		if (content === undefined) {
			return formatTelegramInlineMarkdown(line);
		}
		return `${indentation}\\- ${formatTelegramInlineMarkdown(content)}`;
	}

	const orderedListMatch = line.match(/^(\s*)(\d+)([.)])\s+(.+)$/);
	if (orderedListMatch) {
		const indentation = orderedListMatch[1] ?? "";
		const number = orderedListMatch[2];
		const delimiter = orderedListMatch[3];
		const content = orderedListMatch[4];
		if (number === undefined || delimiter === undefined || content === undefined) {
			return formatTelegramInlineMarkdown(line);
		}
		return `${indentation}${number}${escapeTelegramMarkdownV2Text(delimiter)} ${formatTelegramInlineMarkdown(content)}`;
	}

	return formatTelegramInlineMarkdown(line);
}

function formatTelegramInlineMarkdown(text: string): string {
	const entities: string[] = [];
	let workingText = text;

	workingText = replaceMarkdownEntity(workingText, /`([^`\n]+)`/g, (code) => {
		return `\`${escapeTelegramMarkdownV2Code(code)}\``;
	}, entities);

	workingText = replaceMarkdownEntity(workingText, /\*\*([^*\n][^*\n]*?)\*\*/g, (boldText) => {
		return `*${escapeTelegramMarkdownV2Text(boldText)}*`;
	}, entities);

	workingText = replaceMarkdownEntity(workingText, /~~([^~\n][^~\n]*?)~~/g, (strikethroughText) => {
		return `~${escapeTelegramMarkdownV2Text(strikethroughText)}~`;
	}, entities);

	return escapeTelegramMarkdownV2Text(workingText).replace(PLACEHOLDER_PATTERN, (_match, index) => {
		return entities[Number(index)] ?? "";
	});
}

function replaceMarkdownEntity(
	text: string,
	pattern: RegExp,
	formatMatch: (value: string) => string,
	entities: string[],
): string {
	return text.replace(pattern, (_match, value: string) => {
		const entityIndex = entities.length;
		entities.push(formatMatch(value));
		return `\u0000${entityIndex}\u0000`;
	});
}

function escapeTelegramMarkdownV2Text(text: string): string {
	return text.replace(TELEGRAM_MARKDOWN_V2_ESCAPE_PATTERN, "\\$1");
}

function escapeTelegramMarkdownV2Code(text: string): string {
	return text.replace(TELEGRAM_MARKDOWN_V2_CODE_ESCAPE_PATTERN, "\\$1");
}
