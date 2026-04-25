import type { PiSessionEvent, SessionMessageLike } from "../pi/pi-types.js";

export function isAssistantMessageEvent(event: PiSessionEvent): boolean {
	return (
		(event.type === "message_update" || event.type === "message_end") &&
		event.message?.role === "assistant"
	);
}

export function extractMessageText(message: SessionMessageLike | undefined): string {
	if (!message?.content) {
		return "";
	}

	if (typeof message.content === "string") {
		return message.content;
	}

	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}
