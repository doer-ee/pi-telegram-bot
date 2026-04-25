export function parseSwitchCommandTarget(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/switch")) {
		return undefined;
	}

	const target = trimmed.slice("/switch".length).trim();
	return target.length > 0 ? target : undefined;
}
