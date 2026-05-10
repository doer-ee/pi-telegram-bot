import { describe, expect, it, vi } from "vitest";
import {
	createProcessLifecycleLogContext,
	formatProcessLifecycleLogMessage,
} from "../src/app-lifecycle-logging.js";

describe("app-lifecycle-logging", () => {
	it("#given a process lifecycle context #when formatting startup and shutdown logs #then the same pid and startup instance id stay attached", () => {
		const startupInstanceIdFactory = vi.fn(() => "startup-1");

		const context = createProcessLifecycleLogContext({
			pid: 4321,
			startupInstanceIdFactory,
		});

		expect(startupInstanceIdFactory).toHaveBeenCalledTimes(1);
		expect(context).toEqual({
			pid: 4321,
			startupInstanceId: "startup-1",
		});
		expect(formatProcessLifecycleLogMessage(context, "starting bot")).toBe(
			"[pi-telegram-bot] starting bot pid=4321 startupInstanceId=startup-1",
		);
		expect(formatProcessLifecycleLogMessage(context, "stopping on SIGTERM")).toBe(
			"[pi-telegram-bot] stopping on SIGTERM pid=4321 startupInstanceId=startup-1",
		);
	});
});
