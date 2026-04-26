import {
	COMPLETE_FENCED_CODE_BLOCK_PATTERN,
	consumeMarkdownPipeTable,
	type MarkdownPipeTableAlignment,
	type MarkdownPipeTableBlock,
} from "./markdown-blocks.js";

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
	const lines = text.split("\n");
	const formattedLines: string[] = [];

	for (let lineIndex = 0; lineIndex < lines.length;) {
		const tableBlock = consumeMarkdownPipeTable(lines, lineIndex);
		if (tableBlock) {
			formattedLines.push(formatTelegramCodeBlock(renderMarkdownPipeTable(tableBlock)));
			lineIndex = tableBlock.nextIndex;
			continue;
		}

		formattedLines.push(formatTelegramMarkdownLine(lines[lineIndex] ?? ""));
		lineIndex += 1;
	}

	return formattedLines.join("\n");
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

function renderMarkdownPipeTable(tableBlock: MarkdownPipeTableBlock): string {
	const columnWidths = tableBlock.rows[0]?.map((_cell, columnIndex) => {
		const widestCellLength = tableBlock.rows.reduce((widestLength, row) => {
			return Math.max(widestLength, row[columnIndex]?.length ?? 0);
		}, 0);
		return Math.max(3, widestCellLength);
	}) ?? [];

	const renderedRows = [
		renderMarkdownPipeTableRow(tableBlock.rows[0] ?? [], columnWidths, tableBlock.alignments),
		columnWidths.map((width) => "-".repeat(width)).join(" | "),
		...tableBlock.rows.slice(1).map((row) => renderMarkdownPipeTableRow(row, columnWidths, tableBlock.alignments)),
	];

	return renderedRows.join("\n");
}

function renderMarkdownPipeTableRow(
	row: string[],
	columnWidths: number[],
	alignments: MarkdownPipeTableAlignment[],
): string {
	return row
		.map((cell, columnIndex) => formatMarkdownPipeTableCell(cell, columnWidths[columnIndex] ?? cell.length, alignments[columnIndex] ?? "left"))
		.join(" | ");
}

function formatMarkdownPipeTableCell(
	cell: string,
	width: number,
	alignment: MarkdownPipeTableAlignment,
): string {
	switch (alignment) {
		case "right":
			return cell.padStart(width);
		case "center": {
			const totalPadding = Math.max(0, width - cell.length);
			const leftPadding = Math.floor(totalPadding / 2);
			const rightPadding = totalPadding - leftPadding;
			return `${" ".repeat(leftPadding)}${cell}${" ".repeat(rightPadding)}`;
		}
		default:
			return cell.padEnd(width);
	}
}
