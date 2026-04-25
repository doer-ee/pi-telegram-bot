export function chunkText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		const slice = remaining.slice(0, maxLength);
		const newlineIndex = slice.lastIndexOf("\n");
		const spaceIndex = slice.lastIndexOf(" ");
		const breakIndex = Math.max(newlineIndex, spaceIndex);
		const safeBreak = breakIndex >= Math.floor(maxLength / 2) ? breakIndex : maxLength;
		chunks.push(remaining.slice(0, safeBreak).trimEnd());
		remaining = remaining.slice(safeBreak).trimStart();
	}

	return chunks.filter((chunk) => chunk.length > 0);
}
