import type { PiSessionEventListener, PiSessionPort } from "../pi/pi-types.js";

export class SessionEventBinding {
	private readonly listeners = new Set<PiSessionEventListener>();
	private unsubscribeCurrent: (() => void) | undefined;

	rebind(session: PiSessionPort): void {
		this.unsubscribeCurrent?.();
		this.unsubscribeCurrent = session.subscribe((event) => {
			for (const listener of this.listeners) {
				listener(event);
			}
		});
	}

	addListener(listener: PiSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.unsubscribeCurrent?.();
		this.unsubscribeCurrent = undefined;
		this.listeners.clear();
	}
}
