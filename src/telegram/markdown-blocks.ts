export const COMPLETE_FENCED_CODE_BLOCK_PATTERN = /```[^\n`]*\n([\s\S]*?)```/g;

const HEADING_LINE_PATTERN = /^#{1,6}\s+/;
const BULLET_LINE_PATTERN = /^[-*+]\s+/;
const ORDERED_LIST_LINE_PATTERN = /^\d+[.)]\s+/;
const BLOCKQUOTE_LINE_PATTERN = /^>\s?/;
const FENCE_LINE_PATTERN = /^```/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

export type MarkdownPipeTableAlignment = "left" | "center" | "right";

export interface MarkdownPipeTableBlock {
	rawLines: string[];
	rows: string[][];
	alignments: MarkdownPipeTableAlignment[];
	nextIndex: number;
}

export type MarkdownPipeTableLikeBlock = MarkdownValidPipeTableBlock | MarkdownAmbiguousPipeTableBlock;

export interface MarkdownAmbiguousPipeTableBlock {
	kind: "ambiguous";
	rawLines: string[];
	nextIndex: number;
}

interface MarkdownValidPipeTableBlock extends MarkdownPipeTableBlock {
	kind: "valid";
}

export function consumeMarkdownPipeTable(
	lines: string[],
	startIndex: number,
): MarkdownPipeTableBlock | undefined {
	const tableLikeBlock = consumeMarkdownPipeTableLikeBlock(lines, startIndex);
	if (tableLikeBlock?.kind !== "valid") {
		return undefined;
	}

	return tableLikeBlock;
}

export function consumeMarkdownPipeTableLikeBlock(
	lines: string[],
	startIndex: number,
): MarkdownPipeTableLikeBlock | undefined {
	const headerLine = lines[startIndex];
	const separatorLine = lines[startIndex + 1];
	if (headerLine === undefined || separatorLine === undefined) {
		return undefined;
	}

	if (!isPotentialMarkdownTableLine(headerLine) || !isPotentialMarkdownTableLine(separatorLine)) {
		return undefined;
	}

	const headerCells = parseMarkdownPipeTableRow(headerLine);
	const separatorCells = parseMarkdownPipeTableSeparator(separatorLine);
	if (headerCells === undefined || separatorCells === undefined) {
		return undefined;
	}

	if (headerCells.length < 2 || headerCells.length !== separatorCells.length) {
		return undefined;
	}

	const rawLines = [headerLine, separatorLine];
	const rows = [headerCells];
	let isValidTable = true;
	let lineIndex = startIndex + 2;

	for (; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		if (line.trim().length === 0) {
			break;
		}

		if (!isPotentialMarkdownTableLine(line)) {
			break;
		}

		const bodyCells = parseMarkdownPipeTableRow(line);
		if (bodyCells === undefined || bodyCells.length !== headerCells.length) {
			isValidTable = false;
			rawLines.push(line);
			continue;
		}

		rawLines.push(line);
		if (isValidTable) {
			rows.push(bodyCells);
		}
	}

	if (!isValidTable) {
		return {
			kind: "ambiguous",
			rawLines,
			nextIndex: lineIndex,
		};
	}

	return {
		kind: "valid",
		rawLines,
		rows,
		alignments: separatorCells.map((cell) => getMarkdownTableAlignment(cell)),
		nextIndex: lineIndex,
	};
}

export function isMarkdownPipeTableSeparatorLine(line: string): boolean {
	return parseMarkdownPipeTableSeparator(line) !== undefined;
}

function isPotentialMarkdownTableLine(line: string): boolean {
	const trimmedLine = line.trim();
	if (trimmedLine.length === 0) {
		return false;
	}

	if (
		HEADING_LINE_PATTERN.test(trimmedLine) ||
		BULLET_LINE_PATTERN.test(trimmedLine) ||
		ORDERED_LIST_LINE_PATTERN.test(trimmedLine) ||
		BLOCKQUOTE_LINE_PATTERN.test(trimmedLine) ||
		FENCE_LINE_PATTERN.test(trimmedLine)
	) {
		return false;
	}

	return countUnescapedPipes(trimmedLine) >= 1;
}

function parseMarkdownPipeTableSeparator(line: string): string[] | undefined {
	const cells = parseMarkdownPipeTableRow(line);
	if (cells === undefined || cells.length < 2) {
		return undefined;
	}

	return cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell)) ? cells : undefined;
}

function parseMarkdownPipeTableRow(line: string): string[] | undefined {
	const trimmedLine = line.trim();
	if (trimmedLine.length === 0 || countUnescapedPipes(trimmedLine) < 1) {
		return undefined;
	}

	let innerLine = trimmedLine;
	if (innerLine.startsWith("|")) {
		innerLine = innerLine.slice(1);
	}
	if (innerLine.endsWith("|")) {
		innerLine = innerLine.slice(0, -1);
	}

	return splitOnUnescapedPipes(innerLine).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function splitOnUnescapedPipes(line: string): string[] {
	const cells: string[] = [];
	let currentCell = "";

	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === "|" && line[index - 1] !== "\\") {
			cells.push(currentCell);
			currentCell = "";
			continue;
		}

		currentCell += character;
	}

	cells.push(currentCell);
	return cells;
}

function countUnescapedPipes(line: string): number {
	let count = 0;
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === "|" && line[index - 1] !== "\\") {
			count += 1;
		}
	}

	return count;
}

function getMarkdownTableAlignment(cell: string): MarkdownPipeTableAlignment {
	const isLeftAligned = cell.startsWith(":");
	const isRightAligned = cell.endsWith(":");
	if (isLeftAligned && isRightAligned) {
		return "center";
	}

	if (isRightAligned) {
		return "right";
	}

	return "left";
}
