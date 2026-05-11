import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiDocparserRuntimeSupportResolver } from "../src/pi/pi-docparser-runtime-support.js";

const createdTempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (createdTempDirs.length > 0) {
		const tempDir = createdTempDirs.pop();
		if (!tempDir) {
			continue;
		}

		await rm(tempDir, { recursive: true, force: true });
	}
});

describe("createPiDocparserRuntimeSupportResolver", () => {
	it("resolves the installed pi-docparser extension path and verifies the document_parse tool", async () => {
		const packageRoot = await createInstalledPiDocparserPackage();
		const bindExtensions = vi.fn(async () => undefined);
		const dispose = vi.fn();
		const findExecutable = vi.fn(async () => undefined);
		const resolver = createPiDocparserRuntimeSupportResolver({
			findFirstAvailableExecutable: findExecutable,
			createPackageManager: () => ({
				listConfiguredPackages: () => [{
					source: "npm:pi-docparser",
					scope: "user",
					installedPath: packageRoot,
				}],
			}),
			createProbeSession: async () => ({
				diagnostics: [],
				session: {
					bindExtensions,
					getAllTools: () => [{ name: "document_parse" }],
					dispose,
				},
			}),
		});

		const support = await resolver.resolve({
			workspacePath: "/workspace",
			fileName: "brief.pdf",
			mimeType: "application/pdf",
		});

		expect(support).toEqual({
			packageSource: "npm:pi-docparser",
			packageScope: "user",
			packageRoot,
			extensionEntryPath: join(packageRoot, "extensions", "docparser", "index.ts"),
			toolName: "document_parse",
		});
		expect(bindExtensions).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(findExecutable).not.toHaveBeenCalled();
	});

	it("fails explicitly when npm:pi-docparser is not configured in Pi settings", async () => {
		const resolver = createPiDocparserRuntimeSupportResolver({
			createPackageManager: () => ({
				listConfiguredPackages: () => [],
			}),
			createProbeSession: async () => {
				throw new Error("Unexpected session probe.");
			},
		});

		await expect(
			resolver.resolve({
				workspacePath: "/workspace",
				fileName: "brief.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(
			"npm:pi-docparser is not configured in the current Pi package settings. Run pi install npm:pi-docparser first.",
		);
	});

	it("fails explicitly when the installed extension does not register the document_parse tool", async () => {
		const packageRoot = await createInstalledPiDocparserPackage();
		const resolver = createPiDocparserRuntimeSupportResolver({
			createPackageManager: () => ({
				listConfiguredPackages: () => [{
					source: "npm:pi-docparser",
					scope: "user",
					installedPath: packageRoot,
				}],
			}),
			createProbeSession: async () => ({
				diagnostics: [],
				session: {
					bindExtensions: async () => undefined,
					getAllTools: () => [{ name: "read" }],
					dispose: () => undefined,
				},
			}),
		});

		await expect(
			resolver.resolve({
				workspacePath: "/workspace",
				fileName: "brief.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(
			`the installed pi-docparser extension at ${join(packageRoot, "extensions", "docparser", "index.ts")} did not register the document_parse tool`,
		);
	});

	it("requires LibreOffice for parser-backed office documents", async () => {
		const packageRoot = await createInstalledPiDocparserPackage();
		const findExecutable = vi.fn(async () => undefined);
		const resolver = createPiDocparserRuntimeSupportResolver({
			findFirstAvailableExecutable: findExecutable,
			createPackageManager: () => ({
				listConfiguredPackages: () => [{
					source: "npm:pi-docparser",
					scope: "user",
					installedPath: packageRoot,
				}],
			}),
			createProbeSession: async () => ({
				diagnostics: [],
				session: {
					bindExtensions: async () => undefined,
					getAllTools: () => [{ name: "document_parse" }],
					dispose: () => undefined,
				},
			}),
		});

		await expect(
			resolver.resolve({
				workspacePath: "/workspace",
				fileName: "report.docx",
				mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
		).rejects.toThrow(
			"LibreOffice is not installed for parser-backed office document support. Install it with: brew install --cask libreoffice",
		);
		expect(findExecutable).toHaveBeenCalledOnce();
	});
});

async function createInstalledPiDocparserPackage(): Promise<string> {
	const packageRoot = await mkdtemp(join(tmpdir(), "pi-docparser-runtime-support-"));
	createdTempDirs.push(packageRoot);
	await mkdir(join(packageRoot, "extensions", "docparser"), { recursive: true });
	await writeFile(join(packageRoot, "extensions", "docparser", "index.ts"), "export default {};\n", "utf8");
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "pi-docparser",
			pi: {
				extensions: ["./extensions/docparser/index.ts"],
			},
		}),
		"utf8",
	);
	return packageRoot;
}
