import {
	COMPLETE_FENCED_CODE_BLOCK_PATTERN,
	consumeMarkdownPipeTableLikeBlock,
	isMarkdownPipeTableSeparatorLine,
} from "./markdown-blocks.js";

export function chunkText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let currentChunk = "";
	let lastIndex = 0;

	for (const match of text.matchAll(COMPLETE_FENCED_CODE_BLOCK_PATTERN)) {
		const matchIndex = match.index ?? 0;
		appendTextSegment(text.slice(lastIndex, matchIndex));
		appendFencedCodeBlock(match[0], maxLength);
		lastIndex = matchIndex + match[0].length;
	}

	appendTextSegment(text.slice(lastIndex));
	pushCurrentChunk();
	return chunks.filter((chunk) => chunk.length > 0);

	function appendTextSegment(segment: string): void {
		for (const part of splitTextSegmentByMarkdownTables(segment)) {
			if (part.type === "table") {
				appendMarkdownTableBlock(part.value, maxLength);
				continue;
			}

			if (part.type === "ambiguous-table") {
				appendAmbiguousMarkdownTableBlock(part.value, maxLength);
				continue;
			}

			appendPlainText(part.value);
		}
	}

	function appendPlainText(segment: string): void {
		let remaining = currentChunk.length === 0 ? segment.trimStart() : segment;

		while (remaining.length > 0) {
			const availableLength = maxLength - currentChunk.length;
			if (availableLength <= 0) {
				pushCurrentChunk();
				remaining = remaining.trimStart();
				continue;
			}

			if (remaining.length <= availableLength) {
				currentChunk += remaining;
				return;
			}

			const splitIndex = findSafeTextBreakIndex(remaining, availableLength);
			currentChunk += remaining.slice(0, splitIndex);
			pushCurrentChunk();
			remaining = remaining.slice(splitIndex).trimStart();
		}
	}

	function appendMarkdownTableBlock(segment: string, maxSegmentLength: number): void {
		const tableChunks = splitMarkdownTableBlock(segment, maxSegmentLength) ?? [segment];
		for (const [index, tableChunk] of tableChunks.entries()) {
			appendAtomicSegment(tableChunk, maxSegmentLength);
			if (index < tableChunks.length - 1) {
				pushCurrentChunk();
			}
		}
	}

	function appendAmbiguousMarkdownTableBlock(segment: string, maxSegmentLength: number): void {
		if (segment.length <= maxSegmentLength) {
			appendAtomicSegment(segment, maxSegmentLength);
			return;
		}

		const blockChunks = splitAmbiguousMarkdownTableBlock(segment, maxSegmentLength);
		for (const [index, blockChunk] of blockChunks.entries()) {
			appendAtomicSegment(blockChunk, maxSegmentLength);
			if (index < blockChunks.length - 1) {
				pushCurrentChunk();
			}
		}
	}

	function appendFencedCodeBlock(segment: string, maxSegmentLength: number): void {
		const blockChunks = splitFencedCodeBlock(segment, maxSegmentLength);
		for (const [index, blockChunk] of blockChunks.entries()) {
			appendAtomicSegment(blockChunk, maxSegmentLength);
			if (index < blockChunks.length - 1) {
				pushCurrentChunk();
			}
		}
	}

	function appendAtomicSegment(segment: string, maxSegmentLength: number): void {
		if (segment.length > maxSegmentLength) {
			appendPlainText(segment);
			return;
		}

		if (currentChunk.length > 0 && currentChunk.length + segment.length > maxSegmentLength) {
			pushCurrentChunk();
		}

		currentChunk += currentChunk.length === 0 ? segment.trimStart() : segment;
	}

	function pushCurrentChunk(): void {
		const normalizedChunk = currentChunk.trimEnd();
		if (normalizedChunk.length > 0) {
			chunks.push(normalizedChunk);
		}
		currentChunk = "";
	}
}

function splitTextSegmentByMarkdownTables(segment: string): Array<{ type: "text" | "table" | "ambiguous-table"; value: string }> {
	if (segment.length === 0) {
		return [];
	}

	const lines = segment.split("\n");
	const lineStartOffsets = getLineStartOffsets(lines);
	const parts: Array<{ type: "text" | "table" | "ambiguous-table"; value: string }> = [];
	let cursor = 0;

	for (let lineIndex = 0; lineIndex < lines.length;) {
		const tableBlock = consumeMarkdownPipeTableLikeBlock(lines, lineIndex);
		if (!tableBlock) {
			lineIndex += 1;
			continue;
		}

		const tableStart = lineStartOffsets[lineIndex] ?? cursor;
		if (cursor < tableStart) {
			parts.push({ type: "text", value: segment.slice(cursor, tableStart) });
		}

		const tableEnd = tableBlock.nextIndex < lineStartOffsets.length
			? Math.max(tableStart, (lineStartOffsets[tableBlock.nextIndex] ?? segment.length) - 1)
			: segment.length;
		parts.push({
			type: tableBlock.kind === "valid" ? "table" : "ambiguous-table",
			value: segment.slice(tableStart, tableEnd),
		});
		cursor = tableEnd;
		lineIndex = tableBlock.nextIndex;
	}

	if (cursor < segment.length) {
		parts.push({ type: "text", value: segment.slice(cursor) });
	}

	return parts;
}

function splitAmbiguousMarkdownTableBlock(table: string, maxLength: number): string[] {
	const structuralPieces = splitAmbiguousMarkdownTableStructure(table);
	const chunks: string[] = [];

	for (const piece of structuralPieces) {
		if (piece.length <= maxLength) {
			chunks.push(piece);
			continue;
		}

		chunks.push(...splitOversizedAmbiguousMarkdownTablePiece(piece, maxLength));
	}

	return chunks;
}

function splitAmbiguousMarkdownTableStructure(table: string): string[] {
	const lines = table.split("\n");
	const pieces: string[] = [];
	let currentPiece: string[] = [];

	for (const [index, line] of lines.entries()) {
		if (index > 0 && isMarkdownPipeTableSeparatorLine(line)) {
			if (currentPiece.length > 0) {
				pieces.push(currentPiece.join("\n"));
			}
			currentPiece = [line];
			continue;
		}

		currentPiece.push(line);
	}

	if (currentPiece.length > 0) {
		pieces.push(currentPiece.join("\n"));
	}

	return pieces;
}

function splitOversizedAmbiguousMarkdownTablePiece(piece: string, maxLength: number): string[] {
	const lines = piece.split("\n");
	const chunks: string[] = [];
	let currentChunk = "";

	for (const line of lines) {
		const lineWithNewline = currentChunk.length === 0 ? line : `\n${line}`;
		if (currentChunk.length > 0 && currentChunk.length + lineWithNewline.length <= maxLength) {
			currentChunk += lineWithNewline;
			continue;
		}

		if (currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = "";
		}

		if (line.length <= maxLength) {
			currentChunk = line;
			continue;
		}

		for (const lineChunk of splitPlainTextLine(line, maxLength)) {
			chunks.push(lineChunk);
		}
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}

function getLineStartOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;

	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}

	return offsets;
}

function splitMarkdownTableBlock(table: string, maxLength: number): string[] | undefined {
	if (table.length <= maxLength) {
		return [table];
	}

	const lines = table.split("\n");
	if (lines.length < 2) {
		return undefined;
	}

	const headerLine = lines[0] ?? "";
	const separatorLine = lines[1] ?? "";
	const bodyLines = lines.slice(2);
	const headerBlock = `${headerLine}\n${separatorLine}`;
	if (headerBlock.length > maxLength) {
		return undefined;
	}

	if (bodyLines.length === 0) {
		return [headerBlock];
	}

	const tableChunks: string[] = [];
	let currentLines = [headerLine, separatorLine];
	let currentLength = headerBlock.length;

	for (const bodyLine of bodyLines) {
		const nextLength = currentLength + 1 + bodyLine.length;
		if (nextLength <= maxLength) {
			currentLines.push(bodyLine);
			currentLength = nextLength;
			continue;
		}

		if (currentLines.length === 2 && headerBlock.length + 1 + bodyLine.length > maxLength) {
			return undefined;
		}

		tableChunks.push(currentLines.join("\n"));
		currentLines = [headerLine, separatorLine, bodyLine];
		currentLength = headerBlock.length + 1 + bodyLine.length;
	}

	tableChunks.push(currentLines.join("\n"));
	return tableChunks;
}

function splitFencedCodeBlock(block: string, maxLength: number): string[] {
	if (block.length <= maxLength) {
		return [block];
	}

	const openingFenceMatch = block.match(/^```[^\n`]*\n/);
	const openingFence = openingFenceMatch?.[0] ?? "```\n";
	const closingFence = "```";
	const contentEndIndex = block.endsWith(closingFence) ? block.length - closingFence.length : block.length;
	const content = block.slice(openingFence.length, contentEndIndex);
	const maxContentLength = maxLength - openingFence.length - closingFence.length;
	if (maxContentLength <= 0) {
		return [block];
	}

	return splitCodeBlockContent(content, maxContentLength).map((part) => {
		const normalizedPart = part.endsWith("\n") ? part : `${part}\n`;
		return `${openingFence}${normalizedPart}${closingFence}`;
	});
}

function splitCodeBlockContent(content: string, maxLength: number): string[] {
	const pieces = content.match(/[^\n]*\n|[^\n]+/g) ?? [""];
	const chunks: string[] = [];
	let currentChunk = "";

	for (const piece of pieces) {
		if (piece.length > maxLength) {
			if (currentChunk.length > 0) {
				chunks.push(currentChunk);
				currentChunk = "";
			}

			for (let index = 0; index < piece.length; index += maxLength) {
				chunks.push(piece.slice(index, index + maxLength));
			}
			continue;
		}

		if (currentChunk.length > 0 && currentChunk.length + piece.length > maxLength) {
			chunks.push(currentChunk);
			currentChunk = piece;
			continue;
		}

		currentChunk += piece;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks.length > 0 ? chunks : [""];
}

function splitPlainTextLine(line: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = line;

	while (remaining.length > maxLength) {
		const splitIndex = findSafeTextBreakIndex(remaining, maxLength);
		chunks.push(remaining.slice(0, splitIndex));
		remaining = remaining.slice(splitIndex).trimStart();
	}

	if (remaining.length > 0) {
		chunks.push(remaining);
	}

	return chunks;
}

function findSafeTextBreakIndex(text: string, maxLength: number): number {
	const slice = text.slice(0, maxLength);
	const newlineIndex = slice.lastIndexOf("\n");
	const spaceIndex = slice.lastIndexOf(" ");
	const breakIndex = Math.max(newlineIndex, spaceIndex);
	return breakIndex >= Math.floor(maxLength / 2) ? breakIndex : maxLength;
}
