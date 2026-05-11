import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Telegram } from "telegraf";
import type { AppConfig } from "../config/app-config.js";
import {
	resolvePiDocparserRuntimeSupport,
	type PiDocparserRuntimeSupport,
	type PiDocparserRuntimeSupportRequest,
} from "../pi/pi-docparser-runtime-support.js";
import type { PiPromptContent } from "../pi/pi-types.js";

export const DEFAULT_TELEGRAM_MEDIA_PROMPT = "describe this item/doc I am sending in";

export interface ResolvedTelegramMediaPrompt {
	content: PiPromptContent;
	cleanup?: () => Promise<void>;
	userPromptText?: string;
}

export type PiDocparserAvailabilityChecker = (
	request: PiDocparserRuntimeSupportRequest,
) => Promise<PiDocparserRuntimeSupport>;

export interface TelegramMediaPromptResolverOptions {
	resolvePiDocparserSupport?: PiDocparserAvailabilityChecker;
	uploadTempRootPath?: string;
}

export interface TelegramPhotoSizeLike {
	file_id: string;
	file_unique_id?: string;
	file_size?: number;
	width?: number;
	height?: number;
}

export interface TelegramDocumentLike {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

export interface TelegramMediaMessageLike {
	caption?: string;
	photo?: TelegramPhotoSizeLike[];
	document?: TelegramDocumentLike;
}

const GENERIC_BINARY_MIME_TYPES = new Set([
	"application/octet-stream",
	"application/octetstream",
	"binary/octet-stream",
]);

const MIME_TYPES_BY_FILE_EXTENSION: Record<string, string> = {
	".avif": "image/avif",
	".bmp": "image/bmp",
	".csv": "text/csv",
	".doc": "application/msword",
	".docm": "application/vnd.ms-word.document.macroenabled.12",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".heic": "image/heic",
	".heif": "image/heif",
	".ico": "image/x-icon",
	".jfif": "image/jpeg",
	".jpe": "image/jpeg",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".log": "text/plain",
	".md": "text/markdown",
	".odp": "application/vnd.oasis.opendocument.presentation",
	".ods": "application/vnd.oasis.opendocument.spreadsheet",
	".odt": "application/vnd.oasis.opendocument.text",
	".pdf": "application/pdf",
	".png": "image/png",
	".ppt": "application/vnd.ms-powerpoint",
	".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".rtf": "application/rtf",
	".svg": "image/svg+xml",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".tsv": "text/tab-separated-values",
	".txt": "text/plain",
	".webp": "image/webp",
	".xls": "application/vnd.ms-excel",
	".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const PLAIN_TEXT_MIME_TYPES = new Set([
	"application/json",
	"application/ld+json",
	"text/csv",
	"text/markdown",
	"text/plain",
	"text/tab-separated-values",
]);

const DOCPARSER_MIME_TYPES = new Set([
	"application/msword",
	"application/pdf",
	"application/rtf",
	"application/vnd.ms-excel",
	"application/vnd.ms-excel.sheet.macroenabled.12",
	"application/vnd.ms-powerpoint",
	"application/vnd.ms-powerpoint.presentation.macroenabled.12",
	"application/vnd.ms-word.document.macroenabled.12",
	"application/vnd.oasis.opendocument.presentation",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export type TelegramMediaPromptResolver = (
	message: TelegramMediaMessageLike,
	config: AppConfig,
	telegram: Telegram,
) => Promise<ResolvedTelegramMediaPrompt>;

export function createTelegramMediaPromptResolver(
	options: TelegramMediaPromptResolverOptions = {},
): TelegramMediaPromptResolver {
	return (message, config, telegram) => resolveTelegramMediaPrompt(message, config, telegram, options);
}

async function resolveTelegramMediaPrompt(
	message: TelegramMediaMessageLike,
	config: AppConfig,
	telegram: Telegram,
	options: TelegramMediaPromptResolverOptions,
): Promise<ResolvedTelegramMediaPrompt> {
	const prompt = normalizeMediaPromptText(message.caption);
	const uploadTempRootPath = options.uploadTempRootPath ?? tmpdir();
	const largestPhoto = selectLargestPhoto(message.photo);
	if (largestPhoto) {
		const downloaded = await downloadTelegramFile({
			telegram,
			telegramBotToken: config.telegramBotToken,
			fileId: largestPhoto.file_id,
			uploadTempRootPath,
			preferredMimeType: "image/jpeg",
			fallbackFileName: `${largestPhoto.file_unique_id ?? largestPhoto.file_id}.jpg`,
		});

		return {
			content: [
				{ type: "text", text: prompt },
				{ type: "image", data: downloaded.buffer.toString("base64"), mimeType: downloaded.mimeType },
			],
			cleanup: downloaded.cleanup,
			userPromptText: prompt,
		};
	}

	const document = message.document;
	if (!document) {
		throw new Error("Unsupported Telegram media message.");
	}
	const declaredDocumentMimeType = normalizeMimeType(document.mime_type);

	const route = resolveTelegramDocumentRoute(document);
	if (route.kind === "image") {
		const downloaded = await downloadTelegramFile({
			telegram,
			telegramBotToken: config.telegramBotToken,
			fileId: document.file_id,
			uploadTempRootPath,
			preferredMimeType: route.mimeType,
			fallbackFileName: document.file_name ?? `${document.file_id}${fileExtensionForMimeType(route.mimeType)}`,
		});

		return {
			content: [
				{ type: "text", text: prompt },
				{ type: "image", data: downloaded.buffer.toString("base64"), mimeType: downloaded.mimeType },
			],
			cleanup: downloaded.cleanup,
			userPromptText: prompt,
		};
	}

	if (route.kind === "plain_text") {
		const downloaded = await downloadTelegramFile({
			telegram,
			telegramBotToken: config.telegramBotToken,
			fileId: document.file_id,
			uploadTempRootPath,
			preferredMimeType: route.mimeType,
			fallbackFileName: document.file_name ?? `${document.file_id}${fileExtensionForMimeType(route.mimeType)}`,
		});

		return {
			content: buildPlainTextDocumentPrompt(prompt, downloaded.filePath),
			cleanup: downloaded.cleanup,
			userPromptText: prompt,
		};
	}

	if (route.kind === "docparser") {
		const resolvePiDocparserSupport = options.resolvePiDocparserSupport ?? defaultResolvePiDocparserSupport;
		let docparserSupport: PiDocparserRuntimeSupport;
		try {
			docparserSupport = await resolvePiDocparserSupport({
				workspacePath: config.workspacePath,
				...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
				...(document.file_name !== undefined ? { fileName: document.file_name } : {}),
				...(route.mimeType !== undefined ? { mimeType: route.mimeType } : {}),
			});
		} catch (error) {
			throw new Error(
				`pi-docparser is unavailable in the bot environment (${describePiDocparserAvailabilityFailure(error)}), so ${route.fileLabel} was not sent to Pi.`,
			);
		}

		const downloaded = await downloadTelegramFile({
			telegram,
			telegramBotToken: config.telegramBotToken,
			fileId: document.file_id,
			uploadTempRootPath,
			preferredMimeType: route.mimeType,
			fallbackFileName: buildDocparserFallbackFileName({
				fileId: document.file_id,
				fileName: document.file_name,
				routedMimeType: route.mimeType,
				declaredMimeType: declaredDocumentMimeType,
			}),
		});

		return {
			content: buildPiDocparserDocumentPrompt(prompt, downloaded.filePath, docparserSupport),
			cleanup: downloaded.cleanup,
			userPromptText: prompt,
		};
	}

	throw new Error(route.errorMessage);
}

function normalizeMediaPromptText(caption: string | undefined): string {
	const trimmedCaption = caption?.trim();
	return trimmedCaption && trimmedCaption.length > 0 ? trimmedCaption : DEFAULT_TELEGRAM_MEDIA_PROMPT;
}

function selectLargestPhoto(photos: readonly TelegramPhotoSizeLike[] | undefined): TelegramPhotoSizeLike | undefined {
	if (!photos || photos.length === 0) {
		return undefined;
	}

	return [...photos].sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0];
}

async function downloadTelegramFile(options: {
	telegram: Telegram;
	telegramBotToken: string;
	fileId: string;
	uploadTempRootPath: string;
	preferredMimeType: string | undefined;
	fallbackFileName: string;
}): Promise<{ buffer: Buffer; filePath: string; mimeType: string; cleanup: () => Promise<void> }> {
	const file = await options.telegram.getFile(options.fileId);
	if (!file.file_path) {
		throw new Error("Telegram did not return a downloadable file path for the uploaded item.");
	}

	const response = await fetch(`https://api.telegram.org/file/bot${options.telegramBotToken}/${file.file_path}`);
	if (!response.ok) {
		throw new Error(`Telegram file download failed with status ${response.status}.`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const systemTempRoot = options.uploadTempRootPath;
	const tempDir = await mkdtemp(join(systemTempRoot, "telegram-upload-"));
	const fileName = sanitizeTelegramFileName(options.fallbackFileName);
	const filePath = join(tempDir, fileName);
	try {
		await writeFile(filePath, buffer);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw new Error(
			`Telegram upload staging failed under the system temp directory (${systemTempRoot}): ${describeUploadStagingFailure(error)}`,
		);
	}

	try {
		await access(filePath, constants.R_OK);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw new Error(
			`Telegram upload staging saved ${filePath} under the system temp directory, but the current bot runtime could not read it back: ${describeUploadStagingFailure(error)}`,
		);
	}

	const responseMimeType = normalizeMimeType(response.headers.get("content-type"));
	return {
		buffer,
		filePath,
		mimeType: resolveDownloadedMimeType(responseMimeType, options.preferredMimeType),
		cleanup: async () => {
			await rm(tempDir, { recursive: true, force: true });
		},
	};
}

function resolveTelegramDocumentRoute(document: TelegramDocumentLike):
	| { kind: "image"; fileLabel: string; mimeType: string; routeSource: "declared_mime" | "inferred_filename" }
	| { kind: "plain_text"; fileLabel: string; mimeType: string | undefined; routeSource: "declared_mime" | "inferred_filename" }
	| { kind: "docparser"; fileLabel: string; mimeType: string | undefined; routeSource: "declared_mime" | "inferred_filename" }
	| { kind: "unsupported"; errorMessage: string } {
	const fileLabel = document.file_name ?? "document";
	const declaredMimeType = normalizeMimeType(document.mime_type);
	const inferredMimeType = inferMimeTypeFromFileName(document.file_name);
	const supportedRoute = resolveSupportedTelegramDocumentRouteFromMimeEvidence(declaredMimeType, inferredMimeType);
	if (supportedRoute) {
		return buildSupportedTelegramDocumentRoute(
			supportedRoute.kind,
			fileLabel,
			supportedRoute.mimeType,
			supportedRoute.routeSource,
		);
	}

	const extension = extname(document.file_name ?? "").toLowerCase();
	const documentType = declaredMimeType ?? (extension.length > 0 ? extension : "unknown document type");
	return {
		kind: "unsupported",
		errorMessage: `Unsupported Telegram document format for Pi processing: ${fileLabel} (${documentType}). This document was not sent to Pi.`,
	};
}

function resolveSupportedTelegramDocumentRouteFromMimeEvidence(
	declaredMimeType: string | undefined,
	inferredMimeType: string | undefined,
): {
	kind: "image" | "plain_text" | "docparser";
	mimeType: string | undefined;
	routeSource: "declared_mime" | "inferred_filename";
} | undefined {
	const declaredKind = classifySupportedTelegramDocumentKind(declaredMimeType);
	if (declaredKind && !isLowConfidenceDeclaredTelegramDocumentMimeType(declaredMimeType)) {
		return { kind: declaredKind, mimeType: declaredMimeType, routeSource: "declared_mime" };
	}

	const inferredKind = classifySupportedTelegramDocumentKind(inferredMimeType);
	if (isLowConfidenceDeclaredTelegramDocumentMimeType(declaredMimeType)) {
		if (inferredKind) {
			return { kind: inferredKind, mimeType: inferredMimeType, routeSource: "inferred_filename" };
		}

		return undefined;
	}

	if (declaredKind) {
		return { kind: declaredKind, mimeType: declaredMimeType, routeSource: "declared_mime" };
	}

	return undefined;
}

function buildSupportedTelegramDocumentRoute(
	kind: "image" | "plain_text" | "docparser",
	fileLabel: string,
	mimeType: string | undefined,
	routeSource: "declared_mime" | "inferred_filename",
):
	| { kind: "image"; fileLabel: string; mimeType: string; routeSource: "declared_mime" | "inferred_filename" }
	| { kind: "plain_text"; fileLabel: string; mimeType: string | undefined; routeSource: "declared_mime" | "inferred_filename" }
	| { kind: "docparser"; fileLabel: string; mimeType: string | undefined; routeSource: "declared_mime" | "inferred_filename" } {
	if (kind === "image") {
		return {
			kind,
			fileLabel,
			mimeType: mimeType ?? "image/jpeg",
			routeSource,
		};
	}

	return {
		kind,
		fileLabel,
		mimeType,
		routeSource,
	};
}

function classifySupportedTelegramDocumentKind(
	mimeType: string | undefined,
): "image" | "plain_text" | "docparser" | undefined {
	if (!mimeType) {
		return undefined;
	}

	if (mimeType.startsWith("image/")) {
		return "image";
	}

	if (DOCPARSER_MIME_TYPES.has(mimeType)) {
		return "docparser";
	}

	if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) {
		return "plain_text";
	}

	return undefined;
}

function isLowConfidenceDeclaredTelegramDocumentMimeType(mimeType: string | undefined): boolean {
	// Telegram's broad text/plain label is not decisive enough to grant plain-text
	// support by itself or to override a clear supported filename. Explicit supported
	// MIME types like image/png, application/pdf, text/csv, or application/json are
	// still strong enough to route directly.
	return mimeType === undefined || isGenericBinaryMimeType(mimeType) || mimeType === "text/plain";
}

function resolveDownloadedMimeType(
	responseMimeType: string | undefined,
	preferredMimeType: string | undefined,
): string {
	if (responseMimeType && !isGenericBinaryMimeType(responseMimeType)) {
		if (shouldPreferConfirmedImageMimeType(responseMimeType, preferredMimeType)) {
			return preferredMimeType;
		}

		return responseMimeType;
	}

	return preferredMimeType ?? "application/octet-stream";
}

function shouldPreferConfirmedImageMimeType(
	responseMimeType: string,
	preferredMimeType: string | undefined,
): preferredMimeType is string {
	return isImageMimeType(preferredMimeType) && !isImageMimeType(responseMimeType);
}

function normalizeMimeType(contentTypeHeader: string | null | undefined): string | undefined {
	if (!contentTypeHeader) {
		return undefined;
	}

	const [mimeType] = contentTypeHeader.split(";", 1);
	const normalized = mimeType?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function isGenericBinaryMimeType(mimeType: string | undefined): boolean {
	return mimeType !== undefined && GENERIC_BINARY_MIME_TYPES.has(mimeType);
}

function isImageMimeType(mimeType: string | undefined): mimeType is string {
	return mimeType?.startsWith("image/") === true;
}

function sanitizeTelegramFileName(fileName: string): string {
	const trimmed = basename(fileName).trim();
	const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
	return sanitized.length > 0 ? sanitized : "telegram-upload";
}

function buildDocparserFallbackFileName(options: {
	fileId: string;
	fileName: string | undefined;
	routedMimeType: string | undefined;
	declaredMimeType: string | undefined;
}): string {
	const preferredExtension = fileExtensionForMimeType(options.routedMimeType);
	const fileName = options.fileName;
	if (!fileName) {
		return `${options.fileId}${preferredExtension}`;
	}

	if (preferredExtension.length === 0) {
		return fileName;
	}

	const inferredMimeType = inferMimeTypeFromFileName(fileName);
	if (inferredMimeType === options.routedMimeType) {
		return fileName;
	}

	if (!options.declaredMimeType || isLowConfidenceDeclaredTelegramDocumentMimeType(options.declaredMimeType)) {
		return fileName;
	}

	return replaceOrAppendFileExtension(fileName, preferredExtension);
}

function replaceOrAppendFileExtension(fileName: string, extension: string): string {
	const currentExtension = extname(fileName);
	if (currentExtension.length === 0) {
		return `${fileName}${extension}`;
	}

	return `${fileName.slice(0, -currentExtension.length)}${extension}`;
}

function buildPlainTextDocumentPrompt(prompt: string, filePath: string): string {
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

function buildPiDocparserDocumentPrompt(
	prompt: string,
	filePath: string,
	docparserSupport: PiDocparserRuntimeSupport,
): string {
	return [
		prompt,
		"",
		"The user sent a Telegram document that was saved locally at:",
		filePath,
		"",
		"This document was not attached directly to the model.",
		"Use the installed document_parse tool from pi-docparser before answering.",
		`pi-docparser package source: ${docparserSupport.packageSource}`,
		`document_parse tool entry: ${docparserSupport.extensionEntryPath}`,
		"Do not use look_at for this document.",
		"If document_parse cannot run or the document format is unsupported, stop and say that explicitly.",
	].join("\n");
}

async function defaultResolvePiDocparserSupport(
	request: PiDocparserRuntimeSupportRequest,
): Promise<PiDocparserRuntimeSupport> {
	return resolvePiDocparserRuntimeSupport(request);
}

function describePiDocparserAvailabilityFailure(error: unknown): string {
	if (error instanceof Error) {
		const normalized = error.message.replace(/\s+/gu, " ").trim();
		if (normalized.length > 0) {
			return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157).trimEnd()}...`;
		}
	}

	return "failed to start cleanly";
}

function describeUploadStagingFailure(error: unknown): string {
	if (error instanceof Error) {
		const normalized = error.message.replace(/\s+/gu, " ").trim();
		if (normalized.length > 0) {
			return normalized;
		}
	}

	return String(error);
}

function inferMimeTypeFromFileName(fileName: string | undefined): string | undefined {
	if (!fileName) {
		return undefined;
	}

	return MIME_TYPES_BY_FILE_EXTENSION[extname(fileName).toLowerCase()];
}

function fileExtensionForMimeType(mimeType: string | undefined): string {
	switch (mimeType) {
		case "application/json":
			return ".json";
		case "application/msword":
			return ".doc";
		case "application/pdf":
			return ".pdf";
		case "application/rtf":
			return ".rtf";
		case "application/vnd.ms-excel":
			return ".xls";
		case "application/vnd.ms-excel.sheet.macroenabled.12":
			return ".xlsm";
		case "application/vnd.ms-powerpoint":
			return ".ppt";
		case "application/vnd.ms-powerpoint.presentation.macroenabled.12":
			return ".pptm";
		case "application/vnd.ms-word.document.macroenabled.12":
			return ".docm";
		case "application/vnd.oasis.opendocument.presentation":
			return ".odp";
		case "application/vnd.oasis.opendocument.spreadsheet":
			return ".ods";
		case "application/vnd.oasis.opendocument.text":
			return ".odt";
		case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
			return ".pptx";
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
			return ".xlsx";
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
			return ".docx";
		case "image/avif":
			return ".avif";
		case "image/bmp":
			return ".bmp";
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/svg+xml":
			return ".svg";
		case "image/tiff":
			return ".tiff";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		case "image/heic":
			return ".heic";
		case "image/heif":
			return ".heif";
		case "image/x-icon":
			return ".ico";
		case "text/csv":
			return ".csv";
		case "text/markdown":
			return ".md";
		case "text/plain":
			return ".txt";
		case "text/tab-separated-values":
			return ".tsv";
		default:
			return "";
	}
}
