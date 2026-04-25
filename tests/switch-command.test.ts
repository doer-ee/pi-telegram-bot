import { describe, expect, it } from "vitest";
import { parseSwitchCommandTarget } from "../src/telegram/switch-command.js";

describe("parseSwitchCommandTarget", () => {
	it("returns the explicit session reference for /switch commands", () => {
		expect(parseSwitchCommandTarget("/switch s2-session")).toBe("s2-session");
		expect(parseSwitchCommandTarget("/switch   s2  ")).toBe("s2");
	});

	it("returns undefined when the switch target is missing", () => {
		expect(parseSwitchCommandTarget("/switch")).toBeUndefined();
		expect(parseSwitchCommandTarget("/switch   ")).toBeUndefined();
	});
});
