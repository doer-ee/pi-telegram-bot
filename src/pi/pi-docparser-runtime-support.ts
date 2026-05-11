import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	DefaultPackageManager,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntimeDiagnostic,
} from "@mariozechner/pi-coding-agent";

const PI_DOCPARSER_SOURCE_PREFIX = "npm:pi-docparser";
const PI_DOCPARSER_TOOL_NAME = "document_parse" as const;
const LIBREOFFICE_CANDIDATE_COMMANDS = ["libreoffice", "soffice"];
const LIBREOFFICE_CANDIDATE_PATHS = [
	"/Applications/LibreOffice.app/Contents/MacOS/soffice",
	"/Applications/LibreOffice.app/Contents/MacOS/libreoffice",
	"C:\\Program Files\\LibreOffice\\program\\soffice.exe",
	"C:\\Program Files\\LibreOffice\\program\\libreoffice.exe",
	"C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
	"C:\\Program Files (x86)\\LibreOffice\\program\\libreoffice.exe",
];

type PackageScope = "project" | "user";

interface PiPackageManifest {
	pi?: {
		extensions?: string[] | string;
	};
}

interface ConfiguredPiPackage {
	source: string;
	scope: PackageScope;
	installedPath?: string;
}

interface ProbeSession {
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	session: {
		bindExtensions(bindings: Record<string, never>): Promise<void>;
		getAllTools(): Array<{ name: string }>;
		dispose(): void;
	};
}

interface PiDocparserRuntimeSupportResolverDependencies {
	readFile?: typeof readFile;
	access?: typeof access;
	findFirstAvailableExecutable?: (options: {
		commandNames: readonly string[];
		candidatePaths: readonly string[];
		accessFn: typeof access;
	}) => Promise<string | undefined>;
	createPackageManager?: (workspacePath: string, agentDir: string) => {
		listConfiguredPackages(): ConfiguredPiPackage[];
	};
	createProbeSession?: (workspacePath: string, agentDir: string) => Promise<ProbeSession>;
}

export interface PiDocparserRuntimeSupportRequest {
	workspacePath: string;
	agentDir?: string;
	fileName?: string;
	mimeType?: string;
}

export interface PiDocparserRuntimeSupport {
	packageSource: string;
	packageScope: PackageScope;
	packageRoot: string;
	extensionEntryPath: string;
	toolName: typeof PI_DOCPARSER_TOOL_NAME;
}

export interface PiDocparserRuntimeSupportResolver {
	resolve(request: PiDocparserRuntimeSupportRequest): Promise<PiDocparserRuntimeSupport>;
	clearCache(): void;
}

export function createPiDocparserRuntimeSupportResolver(
	dependencies: PiDocparserRuntimeSupportResolverDependencies = {},
): PiDocparserRuntimeSupportResolver {
	const readFileFn = dependencies.readFile ?? readFile;
	const accessFn = dependencies.access ?? access;
	const findExecutable = dependencies.findFirstAvailableExecutable ?? findFirstAvailableExecutable;
	const createPackageManager = dependencies.createPackageManager ?? defaultCreatePackageManager;
	const createProbeSession = dependencies.createProbeSession ?? defaultCreateProbeSession;
	const cache = new Map<string, Promise<PiDocparserRuntimeSupport>>();

	return {
		resolve: async (request) => {
			const agentDir = request.agentDir ?? getAgentDir();
			const cacheKey = `${request.workspacePath}::${agentDir}`;
			const baseSupport = await getCachedBaseSupport(cacheKey, async () => {
				const configuredPackage = requireConfiguredPiDocparserPackage(
					createPackageManager(request.workspacePath, agentDir).listConfiguredPackages(),
				);
				const packageRoot = requireInstalledPiDocparserPackageRoot(configuredPackage);
				const manifest = await readPiPackageManifest(packageRoot, readFileFn);
				const extensionEntryPath = await resolvePackageExtensionEntryPath(packageRoot, manifest, accessFn);
				await assertDocumentParseToolRegistered({
					workspacePath: request.workspacePath,
					agentDir,
					extensionEntryPath,
					createProbeSession,
				});

				return {
					packageSource: configuredPackage.source,
					packageScope: configuredPackage.scope,
					packageRoot,
					extensionEntryPath,
					toolName: PI_DOCPARSER_TOOL_NAME,
				};
			});

			await assertHostDependenciesReady({
				accessFn,
				findExecutable,
				...(request.fileName !== undefined ? { fileName: request.fileName } : {}),
				...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
			});

			return baseSupport;
		},
		clearCache: () => {
			cache.clear();
		},
	};

	async function getCachedBaseSupport(
		cacheKey: string,
		compute: () => Promise<PiDocparserRuntimeSupport>,
	): Promise<PiDocparserRuntimeSupport> {
		const cached = cache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const pending = compute().catch((error) => {
			cache.delete(cacheKey);
			throw error;
		});
		cache.set(cacheKey, pending);
		return pending;
	}
}

const defaultResolver = createPiDocparserRuntimeSupportResolver();

export const resolvePiDocparserRuntimeSupport = defaultResolver.resolve;

export function clearPiDocparserRuntimeSupportCache(): void {
	defaultResolver.clearCache();
}

function defaultCreatePackageManager(workspacePath: string, agentDir: string) {
	return new DefaultPackageManager({
		cwd: workspacePath,
		agentDir,
		settingsManager: SettingsManager.create(workspacePath, agentDir),
	});
}

async function defaultCreateProbeSession(workspacePath: string, agentDir: string): Promise<ProbeSession> {
	const services = await createAgentSessionServices({
		cwd: workspacePath,
		agentDir,
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(workspacePath),
	});

	return {
		diagnostics: services.diagnostics,
		session,
	};
}

function requireConfiguredPiDocparserPackage(packages: readonly ConfiguredPiPackage[]): ConfiguredPiPackage {
	const matchingPackages = packages.filter((configuredPackage) => isPiDocparserPackageSource(configuredPackage.source));
	const preferredMatch = matchingPackages.find((configuredPackage) => configuredPackage.scope === "project") ??
		matchingPackages[0];
	if (!preferredMatch) {
		throw new Error(
			`${PI_DOCPARSER_SOURCE_PREFIX} is not configured in the current Pi package settings. Run pi install ${PI_DOCPARSER_SOURCE_PREFIX} first.`,
		);
	}

	return preferredMatch;
}

function requireInstalledPiDocparserPackageRoot(configuredPackage: ConfiguredPiPackage): string {
	if (configuredPackage.installedPath && configuredPackage.installedPath.trim().length > 0) {
		return configuredPackage.installedPath;
	}

	throw new Error(
		`the configured Pi package source ${configuredPackage.source} is not installed in the current Pi package roots. Reinstall it with pi install ${configuredPackage.source}.`,
	);
}

async function readPiPackageManifest(
	packageRoot: string,
	readFileFn: typeof readFile,
): Promise<PiPackageManifest> {
	const manifestPath = join(packageRoot, "package.json");
	let manifestText: string;
	try {
		manifestText = await readFileFn(manifestPath, "utf8");
	} catch (error) {
		throw new Error(`could not read the installed pi-docparser package manifest at ${manifestPath}: ${formatError(error)}`);
	}

	try {
		return JSON.parse(manifestText) as PiPackageManifest;
	} catch (error) {
		throw new Error(`could not parse the installed pi-docparser package manifest at ${manifestPath}: ${formatError(error)}`);
	}
}

async function resolvePackageExtensionEntryPath(
	packageRoot: string,
	manifest: PiPackageManifest,
	accessFn: typeof access,
): Promise<string> {
	const manifestEntries = normalizeManifestEntries(manifest.pi?.extensions);
	const exactEntries = manifestEntries
		.filter((entry) => !entry.includes("*"))
		.map((entry) => join(packageRoot, entry));
	const candidatePaths = exactEntries.length > 0 ? exactEntries : [join(packageRoot, "extensions")];

	for (const candidatePath of candidatePaths) {
		if (await pathExists(candidatePath, accessFn)) {
			return candidatePath;
		}
	}

	const firstManifestEntry = manifestEntries[0];
	if (firstManifestEntry) {
		throw new Error(`the installed pi-docparser extension entry ${join(packageRoot, firstManifestEntry)} was not found`);
	}

	throw new Error(`the installed pi-docparser package at ${packageRoot} does not expose an extension entry`);
}

async function assertDocumentParseToolRegistered(options: {
	workspacePath: string;
	agentDir: string;
	extensionEntryPath: string;
	createProbeSession: (workspacePath: string, agentDir: string) => Promise<ProbeSession>;
}): Promise<void> {
	const { diagnostics, session } = await options.createProbeSession(options.workspacePath, options.agentDir);
	try {
		throwOnDiagnosticErrors(diagnostics);
		await session.bindExtensions({});
		if (session.getAllTools().some((tool) => tool.name === PI_DOCPARSER_TOOL_NAME)) {
			return;
		}

		throw new Error(
			`the installed pi-docparser extension at ${options.extensionEntryPath} did not register the ${PI_DOCPARSER_TOOL_NAME} tool`,
		);
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}

		throw new Error(
			`could not verify the ${PI_DOCPARSER_TOOL_NAME} tool from ${options.extensionEntryPath}: ${String(error)}`,
		);
	} finally {
		safeDispose(session);
	}
}

async function assertHostDependenciesReady(options: {
	fileName?: string;
	mimeType?: string;
	accessFn: typeof access;
	findExecutable: (options: {
		commandNames: readonly string[];
		candidatePaths: readonly string[];
		accessFn: typeof access;
	}) => Promise<string | undefined>;
}): Promise<void> {
	if (!requiresLibreOffice(options.fileName, options.mimeType)) {
		return;
	}

	const libreOfficeCommand = await options.findExecutable({
		commandNames: LIBREOFFICE_CANDIDATE_COMMANDS,
		candidatePaths: LIBREOFFICE_CANDIDATE_PATHS,
		accessFn: options.accessFn,
	});
	if (libreOfficeCommand) {
		return;
	}

	throw new Error(
		`LibreOffice is not installed for parser-backed office document support. Install it with: brew install --cask libreoffice`,
	);
}

function requiresLibreOffice(fileName: string | undefined, mimeType: string | undefined): boolean {
	const normalizedMimeType = mimeType?.trim().toLowerCase();
	if (normalizedMimeType) {
		if (normalizedMimeType === "application/pdf") {
			return false;
		}

		if (OFFICE_LIKE_MIME_TYPES.has(normalizedMimeType)) {
			return true;
		}
	}

	const normalizedFileName = fileName?.trim().toLowerCase();
	if (!normalizedFileName) {
		return false;
	}

	if (normalizedFileName.endsWith(".pdf")) {
		return false;
	}

	return OFFICE_LIKE_FILE_EXTENSIONS.some((extension) => normalizedFileName.endsWith(extension));
}

async function findFirstAvailableExecutable(options: {
	commandNames: readonly string[];
	candidatePaths: readonly string[];
	accessFn: typeof access;
}): Promise<string | undefined> {
	for (const commandName of options.commandNames) {
		if (await isCommandAvailable(commandName)) {
			return commandName;
		}
	}

	for (const candidatePath of options.candidatePaths) {
		if (await pathExists(candidatePath, options.accessFn, fsConstants.X_OK)) {
			return candidatePath;
		}
	}

	return undefined;
}

async function isCommandAvailable(commandName: string): Promise<boolean> {
	try {
		const { execFile } = await import("node:child_process");
		await new Promise<void>((resolve, reject) => {
			execFile(
				process.platform === "win32" ? "where" : "which",
				[commandName],
				{ timeout: 5_000, windowsHide: true },
				(error) => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				},
			);
		});
		return true;
	} catch {
		return false;
	}
}

function normalizeManifestEntries(entries: string[] | string | undefined): string[] {
	if (!entries) {
		return [];
	}

	if (Array.isArray(entries)) {
		return entries;
	}

	return [entries];
}

async function pathExists(
	path: string,
	accessFn: typeof access,
	mode: number = fsConstants.F_OK,
): Promise<boolean> {
	try {
		await accessFn(path, mode);
		return true;
	} catch {
		return false;
	}
}

function throwOnDiagnosticErrors(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length === 0) {
		return;
	}

	throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
}

function safeDispose(session: { dispose(): void }): void {
	try {
		session.dispose();
	} catch {
		return;
	}
}

function isPiDocparserPackageSource(source: string): boolean {
	return source === PI_DOCPARSER_SOURCE_PREFIX || source.startsWith(`${PI_DOCPARSER_SOURCE_PREFIX}@`);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const OFFICE_LIKE_MIME_TYPES = new Set([
	"application/msword",
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

const OFFICE_LIKE_FILE_EXTENSIONS = [
	".doc",
	".docm",
	".docx",
	".odp",
	".ods",
	".odt",
	".ppt",
	".pptm",
	".pptx",
	".rtf",
	".xls",
	".xlsm",
	".xlsx",
];
