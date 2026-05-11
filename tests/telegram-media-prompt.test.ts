import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Telegram } from "telegraf";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import {
	createTelegramMediaPromptResolver,
	DEFAULT_TELEGRAM_MEDIA_PROMPT,
} from "../src/telegram/telegram-media-prompt.js";

describe("createTelegramMediaPromptResolver", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("downloads private photos into the system temp directory and returns a direct image prompt", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("fake-photo-bytes"), {
			status: 200,
			headers: { "content-type": "image/jpeg; charset=binary" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async (fileId: string) => ({
				file_id: fileId,
				file_unique_id: `${fileId}-unique`,
				file_size: 6400,
				file_path: "photos/large.jpg",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				caption: "  inspect this photo  ",
				photo: [
					{ file_id: "photo-small", file_unique_id: "photo-small-unique", file_size: 1200, width: 64, height: 64 },
					{ file_id: "photo-large", file_unique_id: "photo-large-unique", file_size: 6400, width: 256, height: 256 },
				],
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(telegram.getFile).toHaveBeenCalledWith("photo-large");
		expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/bottest-telegram-token/photos/large.jpg");
		expect(resolved.content).toEqual([
			{ type: "text", text: "inspect this photo" },
			{ type: "image", data: Buffer.from("fake-photo-bytes").toString("base64"), mimeType: "image/jpeg" },
		]);
		expect(resolved.userPromptText).toBe("inspect this photo");

		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		expect(uploadDirectory).toMatch(/^telegram-upload-/);
		expect(await readFile(join(stagingRoot, uploadDirectory, "photo-large-unique.jpg"), "utf8")).toBe("fake-photo-bytes");

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);

		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("uses the exact default instruction for captionless image documents when Telegram omits the document mime type", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("fake-document-image"), {
			status: 200,
			headers: { "content-type": "image/png" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-diagram.png",
				file_unique_id: "document-diagram-unique",
				file_size: 2048,
				file_path: "documents/diagram.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "document-diagram.png",
					file_name: "diagram.png",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/bottest-telegram-token/documents/diagram.png");
		expect(resolved.content).toEqual([
			{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
			{ type: "image", data: Buffer.from("fake-document-image").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("accepts image documents when Telegram reports a generic mime type but the filename clearly identifies an image", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("generic-document-image"), {
			status: 200,
			headers: { "content-type": "image/png" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-generic-mime",
				file_unique_id: "document-generic-mime-unique",
				file_size: 2048,
				file_path: "documents/diagram.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				caption: "inspect this diagram",
				document: {
					file_id: "document-generic-mime",
					file_name: "diagram.png",
					mime_type: "application/octet-stream",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/bottest-telegram-token/documents/diagram.png");
		expect(resolved.content).toEqual([
			{ type: "text", text: "inspect this diagram" },
			{ type: "image", data: Buffer.from("generic-document-image").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe("inspect this diagram");

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("keeps image documents on the direct image path when Telegram mislabels a clear image filename as text/plain", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("mislabeled-image"), {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-text-mime-image",
				file_unique_id: "document-text-mime-image-unique",
				file_size: 2048,
				file_path: "documents/render.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				caption: "inspect this render",
				document: {
					file_id: "document-text-mime-image",
					file_name: "render.png",
					mime_type: "text/plain",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolved.content).toEqual([
			{ type: "text", text: "inspect this render" },
			{ type: "image", data: Buffer.from("mislabeled-image").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe("inspect this render");

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("keeps explicit supported image MIME on the direct image path even when the filename looks like plain text", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("image-mime-text-filename"), {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-image-mime-text-name",
				file_unique_id: "document-image-mime-text-name-unique",
				file_size: 2048,
				file_path: "documents/notes.txt",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "document-image-mime-text-name",
					file_name: "notes.txt",
					mime_type: "image/png",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolved.content).toEqual([
			{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
			{ type: "image", data: Buffer.from("image-mime-text-filename").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("keeps explicit supported image MIME on the direct image path even when the filename looks like a pdf", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("image-mime-pdf-filename"), {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-image-mime-pdf-name",
				file_unique_id: "document-image-mime-pdf-name-unique",
				file_size: 2048,
				file_path: "documents/brief.pdf",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "document-image-mime-pdf-name",
					file_name: "brief.pdf",
					mime_type: "image/png",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolved.content).toEqual([
			{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
			{ type: "image", data: Buffer.from("image-mime-pdf-filename").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("keeps a stable image mime type when Telegram file downloads respond with a generic binary header", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("generic-header-image"), {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-generic-header",
				file_unique_id: "document-generic-header-unique",
				file_size: 2048,
				file_path: "documents/render.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "document-generic-header",
					file_name: "render.png",
					mime_type: "image/png",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolved.content).toEqual([
			{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
			{ type: "image", data: Buffer.from("generic-header-image").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("preserves a truthful image mime type when a route-confirmed image document downloads with a conflicting non-image header", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("conflicting-header-image"), {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-conflicting-header",
				file_unique_id: "document-conflicting-header-unique",
				file_size: 2048,
				file_path: "documents/render.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "document-conflicting-header",
					file_name: "render.png",
					mime_type: "text/plain",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolved.content).toEqual([
			{ type: "text", text: DEFAULT_TELEGRAM_MEDIA_PROMPT },
			{ type: "image", data: Buffer.from("conflicting-header-image").toString("base64"), mimeType: "image/png" },
		]);
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("saves supported plain-text documents locally and returns a truthful local-read prompt", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("plain text upload\nsecond line\n"), {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "notes-txt",
				file_unique_id: "notes-txt-unique",
				file_size: 128,
				file_path: "documents/notes.txt",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot);

		const resolved = await resolver(
			{
				document: {
					file_id: "notes-txt",
					file_name: "notes.txt",
					mime_type: "text/plain",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "notes.txt");
		expect(await readFile(savedPath, "utf8")).toBe("plain text upload\nsecond line\n");
		expect(resolved.content).toBe(buildExpectedPlainTextPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("rejects unsupported filenames mislabeled as text/plain instead of granting plain-text support from mime alone", async () => {
		const resolver = createTelegramMediaPromptResolver();
		const telegram = { getFile: vi.fn() } as unknown as Telegram;

		await expect(
			resolver(
				{
					document: {
						file_id: "archive-text-plain",
						file_name: "archive.zip",
						mime_type: "text/plain",
					},
				},
				createAppConfig(),
				telegram,
			),
		).rejects.toThrow(
			"Unsupported Telegram document format for Pi processing: archive.zip (text/plain). This document was not sent to Pi.",
		);
		expect(telegram.getFile).not.toHaveBeenCalled();
	});

	it("routes .pdf documents to pi-docparser when Telegram mislabels them as text/plain", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("mislabeled-pdf-bytes"), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const resolvePiDocparserSupport = vi.fn(async () => createPiDocparserSupport());
		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "brief-text-mime-pdf",
				file_unique_id: "brief-text-mime-pdf-unique",
				file_size: 4096,
				file_path: "documents/brief.pdf",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot, { resolvePiDocparserSupport });

		const resolved = await resolver(
			{
				document: {
					file_id: "brief-text-mime-pdf",
					file_name: "brief.pdf",
					mime_type: "text/plain",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "brief.pdf");
		expect(await readFile(savedPath, "utf8")).toBe("mislabeled-pdf-bytes");
		expect(resolved.content).toBe(buildExpectedPiDocparserPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("saves MIME-driven parser-backed PDFs under a parser-usable .pdf extension when the filename looks like plain text", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("parser-mime-text-filename"), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const resolvePiDocparserSupport = vi.fn(async () => createPiDocparserSupport());
		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-parser-mime-text-name",
				file_unique_id: "document-parser-mime-text-name-unique",
				file_size: 4096,
				file_path: "documents/notes.txt",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot, { resolvePiDocparserSupport });

		const resolved = await resolver(
			{
				document: {
					file_id: "document-parser-mime-text-name",
					file_name: "notes.txt",
					mime_type: "application/pdf",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "notes.pdf");
		expect(await readFile(savedPath, "utf8")).toBe("parser-mime-text-filename");
		expect(resolved.content).toBe(buildExpectedPiDocparserPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("saves MIME-driven parser-backed PDFs under a parser-usable .pdf extension when the filename looks like an image", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("parser-mime-image-filename"), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const resolvePiDocparserSupport = vi.fn(async () => createPiDocparserSupport());
		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-parser-mime-image-name",
				file_unique_id: "document-parser-mime-image-name-unique",
				file_size: 4096,
				file_path: "documents/diagram.png",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot, { resolvePiDocparserSupport });

		const resolved = await resolver(
			{
				document: {
					file_id: "document-parser-mime-image-name",
					file_name: "diagram.png",
					mime_type: "application/pdf",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "diagram.pdf");
		expect(await readFile(savedPath, "utf8")).toBe("parser-mime-image-filename");
		expect(resolved.content).toBe(buildExpectedPiDocparserPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("saves MIME-driven parser-backed office documents under a parser-usable extension consistent with the routed format", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("parser-mime-docx-filename"), {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const resolvePiDocparserSupport = vi.fn(async () => createPiDocparserSupport());
		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "document-parser-mime-docx-name",
				file_unique_id: "document-parser-mime-docx-name-unique",
				file_size: 4096,
				file_path: "documents/notes.txt",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot, { resolvePiDocparserSupport });

		const resolved = await resolver(
			{
				document: {
					file_id: "document-parser-mime-docx-name",
					file_name: "notes.txt",
					mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "notes.docx");
		expect(await readFile(savedPath, "utf8")).toBe("parser-mime-docx-filename");
		expect(resolved.content).toBe(buildExpectedPiDocparserPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("uses the exact default instruction for captionless PDFs and returns a truthful pi-docparser prompt when the parser check passes", async () => {
		const stagingRoot = await createIsolatedSystemTempRoot();
		const fetchMock = vi.fn(async () => new Response(Buffer.from("fake-pdf-bytes"), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const resolvePiDocparserSupport = vi.fn(async () => createPiDocparserSupport());
		const telegram = {
			getFile: vi.fn(async () => ({
				file_id: "brief-pdf",
				file_unique_id: "brief-pdf-unique",
				file_size: 4096,
				file_path: "documents/brief.pdf",
			})),
		};
		const resolver = createResolverForSystemTemp(stagingRoot, { resolvePiDocparserSupport });

		const resolved = await resolver(
			{
				document: {
					file_id: "brief-pdf",
					file_name: "brief.pdf",
					mime_type: "application/pdf",
				},
			},
			createAppConfig(),
			telegram as unknown as Telegram,
		);

		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		const tmpEntries = await readdir(stagingRoot);
		expect(tmpEntries).toHaveLength(1);
		const uploadDirectory = tmpEntries[0];
		if (!uploadDirectory) {
			throw new Error("Expected a Telegram upload directory to be created.");
		}
		const savedPath = join(stagingRoot, uploadDirectory, "brief.pdf");
		expect(await readFile(savedPath, "utf8")).toBe("fake-pdf-bytes");
		expect(resolved.content).toBe(buildExpectedPiDocparserPrompt(DEFAULT_TELEGRAM_MEDIA_PROMPT, savedPath));
		expect(resolved.userPromptText).toBe(DEFAULT_TELEGRAM_MEDIA_PROMPT);

		await resolved.cleanup?.();
		expect(await readdir(stagingRoot)).toEqual([]);
		await rm(stagingRoot, { recursive: true, force: true });
	});

	it("fails explicitly when pi-docparser is unavailable and does not download the document", async () => {
		const resolvePiDocparserSupport = vi.fn(async () => {
			throw new Error("npm:pi-docparser is not configured in the current Pi package settings. Run pi install npm:pi-docparser first.");
		});
		const telegram = {
			getFile: vi.fn(),
		};
		const resolver = createTelegramMediaPromptResolver({ resolvePiDocparserSupport });

		await expect(
			resolver(
				{
					document: {
						file_id: "brief-pdf",
						file_name: "brief.pdf",
						mime_type: "application/pdf",
					},
				},
				createAppConfig(),
				telegram as unknown as Telegram,
			),
		).rejects.toThrow(
			"pi-docparser is unavailable in the bot environment (npm:pi-docparser is not configured in the current Pi package settings. Run pi install npm:pi-docparser first.), so brief.pdf was not sent to Pi.",
		);
		expect(resolvePiDocparserSupport).toHaveBeenCalledOnce();
		expect(telegram.getFile).not.toHaveBeenCalled();
	});

	it("rejects unsupported non-image documents truthfully", async () => {
		const resolver = createTelegramMediaPromptResolver();
		const telegram = { getFile: vi.fn() } as unknown as Telegram;

		await expect(
			resolver(
				{
					document: {
						file_id: "archive-zip",
						file_name: "archive.zip",
						mime_type: "application/zip",
					},
				},
				createAppConfig(),
				telegram,
			),
		).rejects.toThrow(
			"Unsupported Telegram document format for Pi processing: archive.zip (application/zip). This document was not sent to Pi.",
		);
		expect(telegram.getFile).not.toHaveBeenCalled();
	});
});

function buildExpectedPlainTextPrompt(prompt: string, filePath: string): string {
	return [
		prompt,
		"",
		"The user sent a Telegram plain-text document that was saved locally at:",
		filePath,
		"",
		"This document was not attached directly to the model.",
		"Use the normal file-read path on that saved file, then answer the user's request.",
		"If you cannot read the file, say so explicitly.",
	].join("\n");
}

function buildExpectedPiDocparserPrompt(prompt: string, filePath: string): string {
	return [
		prompt,
		"",
		"The user sent a Telegram document that was saved locally at:",
		filePath,
		"",
		"This document was not attached directly to the model.",
		"Use the installed document_parse tool from pi-docparser before answering.",
		"pi-docparser package source: npm:pi-docparser",
		"document_parse tool entry: /Users/example/.nvm/versions/node/v24.11.1/lib/node_modules/pi-docparser/extensions/docparser/index.ts",
		"Do not use look_at for this document.",
		"If document_parse cannot run or the document format is unsupported, stop and say that explicitly.",
	].join("\n");
}

function createPiDocparserSupport() {
	return {
		packageSource: "npm:pi-docparser",
		packageScope: "user" as const,
		packageRoot: "/Users/example/.nvm/versions/node/v24.11.1/lib/node_modules/pi-docparser",
		extensionEntryPath: "/Users/example/.nvm/versions/node/v24.11.1/lib/node_modules/pi-docparser/extensions/docparser/index.ts",
		toolName: "document_parse" as const,
	};
}

function createAppConfig(): AppConfig {
	return {
		telegramBotToken: "test-telegram-token",
		authorizedTelegramUserId: 101,
		workspacePath: "/workspace",
		statePath: "/workspace/data/state.json",
		agentDir: undefined,
		titleRefinementModel: "openai/gpt-5-mini",
		streamThrottleMs: 1000,
		telegramChunkSize: 3500,
	};
}

async function createIsolatedSystemTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-telegram-bot-media-staging-"));
}

function createResolverForSystemTemp(
	stagingRoot: string,
	options: Parameters<typeof createTelegramMediaPromptResolver>[0] = {},
) {
	return createTelegramMediaPromptResolver({
		...options,
		uploadTempRootPath: stagingRoot,
	});
}
