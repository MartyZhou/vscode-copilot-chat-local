/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IntervalTimer } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { LanguageModelChatMessage, LanguageModelTextPart } from '../../../vscodeTypes';
import { IExtensionContribution } from '../../common/contributions';

interface EmailCommandRunnerState {
	readonly mailboxEmail?: string;
	readonly allowedSender?: string;
	readonly model?: string;
	readonly agentType?: string;
	readonly pollIntervalMs?: number;
	readonly dryRun?: boolean;
	readonly lastPollAt?: string;
	readonly activeJob?: unknown;
}

interface EmailCommandRunnerStateUpdate {
	readonly lastPollAt?: string;
	readonly activeJob?: {
		readonly id: string;
		readonly command: string;
		readonly startedAt: string;
		readonly replyTo: string;
		readonly originalSubject: string;
	} | null;
}

interface DaemonConfig {
	readonly workspaceRoot: vscode.Uri;
	readonly stateFileUri: vscode.Uri;
	readonly mailboxEmail: string;
	readonly allowedSender: string;
	readonly preferredModel: string;
	readonly defaultAgentType: string;
	readonly pollIntervalMs: number;
	readonly dryRun: boolean;
}

interface GmailEmail {
	readonly id: string;
	readonly subject: string;
	readonly from: string;
	readonly date: string;
	readonly snippet: string;
	readonly body: string;
}

interface GmailClientModule {
	isGmailConfigured(email: string): boolean;
	listGmailEmails(mailboxEmail: string, query: string, maxResults?: number): Promise<readonly GmailEmail[]>;
	markGmailEmailRead(mailboxEmail: string, messageId: string): Promise<void>;
	sendGmailEmail(fromEmail: string, toEmail: string, subject: string, bodyText: string): Promise<string>;
}

interface ParsedEmailCommand {
	readonly model: string;
	readonly prompt: string;
	readonly agentType: string;
}

interface ParsedEmailCommandDraft {
	readonly model?: string;
	readonly prompt?: string;
	readonly agentType?: string;
}

interface ChatDebugLogEntry {
	readonly ts?: number;
	readonly type?: string;
	readonly attrs?: Record<string, unknown>;
}

interface DaemonDefaults {
	readonly mailboxEmail: string;
	readonly allowedSender: string;
	readonly parseModel: string;
	readonly agentType: string;
	readonly pollIntervalMs: number;
	readonly stateFileRelativePathSegments: readonly string[];
	readonly gmailClientRelativePathSegments: readonly string[];
}

const ENV_DAEMON_MAILBOX_EMAIL = 'COPILOT_AUTOMATION_DAEMON_MAILBOX_EMAIL';
const ENV_DAEMON_ALLOWED_SENDER = 'COPILOT_AUTOMATION_DAEMON_ALLOWED_SENDER';
const ENV_DAEMON_PARSE_MODEL = 'COPILOT_AUTOMATION_DAEMON_PARSE_MODEL';
const ENV_DAEMON_AGENT_TYPE = 'COPILOT_AUTOMATION_DAEMON_AGENT_TYPE';
const ENV_DAEMON_POLL_INTERVAL_MS = 'COPILOT_AUTOMATION_DAEMON_POLL_INTERVAL_MS';
const ENV_DAEMON_STATE_FILE_RELATIVE_PATH = 'COPILOT_AUTOMATION_DAEMON_STATE_FILE_RELATIVE_PATH';
const ENV_DAEMON_GMAIL_CLIENT_RELATIVE_PATH = 'COPILOT_AUTOMATION_DAEMON_GMAIL_CLIENT_RELATIVE_PATH';

const DEFAULT_PARSE_MODEL = 'gpt-5-mini';
const DEFAULT_AGENT_TYPE = 'Automation Orchestrator Agent';
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STATE_FILE_RELATIVE_PATH = 'reports/email-command-runner-state.json';
const DEFAULT_GMAIL_CLIENT_RELATIVE_PATH = 'tools/runners/src/auto-healer/gmail-client.cjs';

const MAX_EMAILS_PER_POLL = 20;
const CHAT_RESULT_TIMEOUT_MS = 90_000;
const CHAT_RESULT_POLL_INTERVAL_MS = 1_500;
const MAX_CHAT_RESULT_EMAIL_CHARS = 8_000;

function readEnvString(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== 'string') {
		return undefined;
	}

	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function parseRelativePathSegments(pathValue: string): readonly string[] {
	return pathValue
		.split(/[\\/]+/)
		.map(segment => segment.trim())
		.filter(segment => !!segment);
}

function parsePollIntervalMs(rawValue: string | undefined, fallback: number): number {
	if (!rawValue) {
		return fallback;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.max(5_000, parsed);
}

function createDaemonDefaults(): DaemonDefaults {
	const statePath = readEnvString(ENV_DAEMON_STATE_FILE_RELATIVE_PATH) ?? DEFAULT_STATE_FILE_RELATIVE_PATH;
	const gmailClientPath = readEnvString(ENV_DAEMON_GMAIL_CLIENT_RELATIVE_PATH) ?? DEFAULT_GMAIL_CLIENT_RELATIVE_PATH;
	const stateFileRelativePathSegments = parseRelativePathSegments(statePath);
	const gmailClientRelativePathSegments = parseRelativePathSegments(gmailClientPath);

	return {
		mailboxEmail: normalizeEmailAddress(readEnvString(ENV_DAEMON_MAILBOX_EMAIL)),
		allowedSender: normalizeEmailAddress(readEnvString(ENV_DAEMON_ALLOWED_SENDER)),
		parseModel: readEnvString(ENV_DAEMON_PARSE_MODEL) ?? DEFAULT_PARSE_MODEL,
		agentType: readEnvString(ENV_DAEMON_AGENT_TYPE) ?? DEFAULT_AGENT_TYPE,
		pollIntervalMs: parsePollIntervalMs(readEnvString(ENV_DAEMON_POLL_INTERVAL_MS), DEFAULT_POLL_INTERVAL_MS),
		stateFileRelativePathSegments: stateFileRelativePathSegments.length > 0
			? stateFileRelativePathSegments
			: parseRelativePathSegments(DEFAULT_STATE_FILE_RELATIVE_PATH),
		gmailClientRelativePathSegments: gmailClientRelativePathSegments.length > 0
			? gmailClientRelativePathSegments
			: parseRelativePathSegments(DEFAULT_GMAIL_CLIENT_RELATIVE_PATH),
	};
}

function normalizeEmailAddress(value: string | undefined): string {
	const raw = String(value ?? '').trim();
	if (!raw) {
		return '';
	}
	const angleMatch = raw.match(/<([^>]+)>/);
	const candidate = angleMatch?.[1] ?? raw;
	return candidate.replace(/[<>]/g, '').trim().toLowerCase();
}

function isGmailClientModule(value: unknown): value is GmailClientModule {
	if (typeof value !== 'object' || !value) {
		return false;
	}

	const candidate = value as {
		readonly isGmailConfigured?: unknown;
		readonly listGmailEmails?: unknown;
		readonly markGmailEmailRead?: unknown;
		readonly sendGmailEmail?: unknown;
	};

	return typeof candidate.isGmailConfigured === 'function'
		&& typeof candidate.listGmailEmails === 'function'
		&& typeof candidate.markGmailEmailRead === 'function'
		&& typeof candidate.sendGmailEmail === 'function';
}

export class AutomationEmailDaemonContribution extends Disposable implements IExtensionContribution {
	readonly id = 'automation.emailDaemon';

	private readonly _intervalTimer = this._register(new IntervalTimer());
	private readonly _encoder = new TextEncoder();
	private readonly _decoder = new TextDecoder();
	private readonly _defaults = createDaemonDefaults();

	private _config: DaemonConfig | undefined;
	private _gmailClient: GmailClientModule | undefined;
	private _pollInProgress = false;

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.initialize().catch(error => {
			this._logService.error(`[AutomationEmailDaemon] Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async initialize(): Promise<void> {
		const automationWorkspaceFolder = await this.findAutomationWorkspaceFolder();
		if (!automationWorkspaceFolder) {
			this._logService.info('[AutomationEmailDaemon] No workspace folder with Gmail client integration found, skipping daemon startup.');
			return;
		}

		const config = await this.loadConfig(automationWorkspaceFolder.uri);
		if (!config) {
			return;
		}

		const gmailClient = await this.loadGmailClient(config.workspaceRoot);
		if (!gmailClient) {
			return;
		}

		if (!gmailClient.isGmailConfigured(config.mailboxEmail)) {
			this._logService.warn(`[AutomationEmailDaemon] Gmail is not configured for ${config.mailboxEmail}. Run token setup in the automation test workspace before enabling daemon flows.`);
			return;
		}

		this._config = config;
		this._gmailClient = gmailClient;

		this._intervalTimer.cancelAndSet(() => {
			void this.pollInbox();
		}, config.pollIntervalMs);

		this._logService.info(`[AutomationEmailDaemon] Started polling every ${config.pollIntervalMs}ms for ${config.mailboxEmail}.`);
		void this.pollInbox();
	}

	private async findAutomationWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of workspaceFolders) {
			const gmailClientUri = vscode.Uri.joinPath(folder.uri, ...this._defaults.gmailClientRelativePathSegments);
			if (await this.fileExists(gmailClientUri)) {
				return folder;
			}
		}

		return undefined;
	}

	private async fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await this._fileSystemService.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async loadConfig(workspaceRoot: vscode.Uri): Promise<DaemonConfig | undefined> {
		const stateFileUri = vscode.Uri.joinPath(workspaceRoot, ...this._defaults.stateFileRelativePathSegments);
		let state: EmailCommandRunnerState = {};

		try {
			const content = await this._fileSystemService.readFile(stateFileUri, true);
			state = JSON.parse(this._decoder.decode(content)) as EmailCommandRunnerState;
		} catch (error) {
			this._logService.warn(`[AutomationEmailDaemon] Failed to read daemon state file (${stateFileUri.fsPath}): ${error instanceof Error ? error.message : String(error)}`);
		}

		const mailboxEmail = normalizeEmailAddress(state.mailboxEmail ?? this._defaults.mailboxEmail) || this._defaults.mailboxEmail;
		const allowedSender = normalizeEmailAddress(state.allowedSender ?? this._defaults.allowedSender) || this._defaults.allowedSender;
		const preferredModel = String(state.model ?? this._defaults.parseModel).trim() || this._defaults.parseModel;
		const defaultAgentType = String(state.agentType ?? this._defaults.agentType).trim() || this._defaults.agentType;
		const pollIntervalMs = parsePollIntervalMs(
			state.pollIntervalMs === undefined ? undefined : String(state.pollIntervalMs),
			this._defaults.pollIntervalMs,
		);

		return {
			workspaceRoot,
			stateFileUri,
			mailboxEmail,
			allowedSender,
			preferredModel,
			defaultAgentType,
			pollIntervalMs,
			dryRun: Boolean(state.dryRun),
		};
	}

	private async loadGmailClient(workspaceRoot: vscode.Uri): Promise<GmailClientModule | undefined> {
		const gmailClientPath = join(workspaceRoot.fsPath, ...this._defaults.gmailClientRelativePathSegments);
		const gmailClientUri = vscode.Uri.file(gmailClientPath);
		try {
			await this._fileSystemService.stat(gmailClientUri);
		} catch {
			this._logService.warn(`[AutomationEmailDaemon] Gmail client not found: ${gmailClientPath}`);
			return undefined;
		}

		try {
			const candidate: unknown = require(gmailClientPath);
			if (!isGmailClientModule(candidate)) {
				this._logService.error('[AutomationEmailDaemon] Loaded gmail-client.cjs, but exports did not match expected API.');
				return undefined;
			}
			return candidate;
		} catch (error) {
			this._logService.error(`[AutomationEmailDaemon] Failed to require gmail-client.cjs: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private async pollInbox(): Promise<void> {
		if (this._pollInProgress || !this._config || !this._gmailClient) {
			return;
		}

		this._pollInProgress = true;
		try {
			const allowedSender = this._config.allowedSender;
			const query = `is:unread in:inbox from:${allowedSender} subject:cmd:`;
			const emails = await this._gmailClient.listGmailEmails(this._config.mailboxEmail, query, MAX_EMAILS_PER_POLL);

			const commandEmails = [...emails]
				.filter(email => this.isCommandEmail(email, allowedSender))
				.sort((left, right) => {
					const leftMs = new Date(left.date ?? 0).getTime();
					const rightMs = new Date(right.date ?? 0).getTime();
					return leftMs - rightMs;
				});

			for (const email of commandEmails) {
				await this.markEmailRead(email.id);
				await this.processCommandEmail(email);
			}

			await this.writeStateSnapshot({ lastPollAt: new Date().toISOString() });
		} catch (error) {
			this._logService.error(`[AutomationEmailDaemon] Poll cycle failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this._pollInProgress = false;
		}
	}

	private isCommandEmail(email: GmailEmail, allowedSender: string): boolean {
		const sender = normalizeEmailAddress(email.from);
		const subject = String(email.subject ?? '').trim().toLowerCase();
		return sender === allowedSender && subject.startsWith('cmd:');
	}

	private async markEmailRead(messageId: string): Promise<void> {
		if (!this._config || !this._gmailClient) {
			return;
		}

		try {
			await this._gmailClient.markGmailEmailRead(this._config.mailboxEmail, messageId);
		} catch (error) {
			this._logService.warn(`[AutomationEmailDaemon] Failed to mark email ${messageId} as read: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async processCommandEmail(email: GmailEmail): Promise<void> {
		if (!this._config) {
			return;
		}

		const requester = normalizeEmailAddress(email.from);
		if (!requester) {
			return;
		}

		await this.writeStateSnapshot({
			activeJob: {
				id: `chat-${Date.now()}`,
				command: `subject:${email.subject}`,
				startedAt: new Date().toISOString(),
				replyTo: requester,
				originalSubject: email.subject,
			}
		});

		try {
			const parsed = await this.parseEmailCommand(email);
			if (!parsed) {
				await this.sendReply(
					requester,
					`Re: ${email.subject}`,
					[
						'No actionable request text was found in the command email.',
						'Include a command or prompt after "cmd:" in the subject or in the body.',
					].join('\n')
				);
				return;
			}

			const safeModel = this.ensureNonPremiumRequestedModel(parsed.model);
			const requestStartTime = Date.now();

			await vscode.commands.executeCommand('workbench.action.chat.open', {
				mode: 'agent',
				query: parsed.prompt,
				model: safeModel,
				agentType: parsed.agentType,
			});

			const chatResult = await this.captureChatResult(parsed.prompt, requestStartTime);

			const downgradedModelNotice = safeModel !== parsed.model
				? `Requested model \"${parsed.model}\" is premium or unsupported for daemon tests. Using non-premium model \"${safeModel}\".\n\n`
				: '';

			await this.sendReply(
				requester,
				`Re: ${email.subject}`,
				[
					'Automation daemon accepted your request and submitted it to the chat panel.',
					'',
					downgradedModelNotice,
					`Configured Model: ${safeModel}`,
					`Configured Agent Type: ${parsed.agentType}`,
					`Prompt: ${parsed.prompt}`,
					'',
					'Chat Result:',
					chatResult ?? 'Result was not captured before timeout. The request is still running in the chat panel.',
				].filter(Boolean).join('\n')
			);
		} catch (error) {
			this._logService.error(`[AutomationEmailDaemon] Failed to process email ${email.id}: ${error instanceof Error ? error.message : String(error)}`);
			await this.sendReply(
				requester,
				`Re: ${email.subject}`,
				`Failed to process command email: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			await this.writeStateSnapshot({ activeJob: null });
		}
	}

	private async parseEmailCommand(email: GmailEmail): Promise<ParsedEmailCommand | undefined> {
		const fallback = this.parseEmailCommandFallback(email);
		const parserModel = await this.selectNonPremiumParserModel(this.getDefaultModel());
		if (!parserModel) {
			this._logService.warn('[AutomationEmailDaemon] No non-premium parser model is available. Expected a mini model such as gpt-5-mini.');
			return fallback;
		}

		const defaultModel = this.getDefaultModel();
		const defaultAgentType = this.getDefaultAgentType();
		const prompt = [
			'Extract automation routing details from this command email.',
			'Return strict JSON with this exact schema:',
			'{"model":"string","prompt":"string","agentType":"string"}',
			'Rules:',
			`- If model is missing, use "${defaultModel}".`,
			'- If prompt is missing, derive it from the email command text in subject/body.',
			`- If agent type is missing, use "${defaultAgentType}".`,
			'- Interpret free-form command patterns such as run/runner/npm/node/help/abort into a useful prompt.',
			'- Return JSON only and no markdown fences.',
			'',
			`Subject: ${email.subject}`,
			`Body:\n${String(email.body ?? '').slice(0, 10_000)}`,
		].join('\n');

		try {
			const response = await parserModel.sendRequest([
				LanguageModelChatMessage.User(prompt)
			], {});

			let raw = '';
			for await (const part of response.stream) {
				if (part instanceof LanguageModelTextPart) {
					raw += part.value;
				}
			}

			const parsed = this.parseCommandJson(raw);
			return this.mergeParsedCommand(parsed, fallback);
		} catch (error) {
			this._logService.warn(`[AutomationEmailDaemon] Parser model request failed: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	}

	private async selectNonPremiumParserModel(preferredModel: string): Promise<vscode.LanguageModelChat | undefined> {
		if (preferredModel) {
			const preferredModels = await vscode.lm.selectChatModels({ id: preferredModel, vendor: 'copilot' });
			const preferred = preferredModels.find(model => this.isNonPremiumModel(model));
			if (preferred) {
				return preferred;
			}
		}

		for (const id of ['gpt-5-mini', 'gpt-4o-mini']) {
			const exactModels = await vscode.lm.selectChatModels({ id, vendor: 'copilot' });
			const exactMatch = exactModels.find(model => this.isNonPremiumModel(model));
			if (exactMatch) {
				return exactMatch;
			}
		}

		const allCopilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		return allCopilotModels.find(model => this.isNonPremiumModel(model));
	}

	private isNonPremiumModel(model: vscode.LanguageModelChat): boolean {
		const fingerprint = `${model.id} ${model.family ?? ''} ${model.name ?? ''}`.toLowerCase();
		return fingerprint.includes('mini') && !fingerprint.includes('pro');
	}

	private getDefaultModel(): string {
		return this._config?.preferredModel ?? this._defaults.parseModel;
	}

	private getDefaultAgentType(): string {
		return this._config?.defaultAgentType ?? this._defaults.agentType;
	}

	private getNonPremiumFallbackModel(): string {
		const model = this.getDefaultModel();
		const lower = model.toLowerCase();
		if (lower.includes('mini') && !lower.includes('pro')) {
			return model;
		}
		return DEFAULT_PARSE_MODEL;
	}

	private ensureNonPremiumRequestedModel(requestedModel: string): string {
		const normalized = String(requestedModel ?? '').trim();
		if (!normalized) {
			return this.getNonPremiumFallbackModel();
		}
		const lower = normalized.toLowerCase();
		if (lower.includes('mini') && !lower.includes('pro')) {
			return normalized;
		}
		return this.getNonPremiumFallbackModel();
	}

	private parseCommandJson(rawValue: string): ParsedEmailCommandDraft | undefined {
		const raw = String(rawValue ?? '').trim();
		if (!raw) {
			return undefined;
		}

		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(jsonMatch[0]) as ParsedEmailCommandDraft;
			const model = String(parsed.model ?? '').trim();
			const prompt = String(parsed.prompt ?? '').trim();
			const agentType = String(parsed.agentType ?? '').trim();

			if (!model && !prompt && !agentType) {
				return undefined;
			}

			return {
				model: model || undefined,
				prompt: prompt || undefined,
				agentType: agentType || undefined,
			};
		} catch {
			return undefined;
		}
	}

	private mergeParsedCommand(
		parsed: ParsedEmailCommandDraft | undefined,
		fallback: ParsedEmailCommand | undefined,
	): ParsedEmailCommand | undefined {
		const model = String(parsed?.model ?? fallback?.model ?? this.getDefaultModel()).trim() || this.getDefaultModel();
		const agentType = String(parsed?.agentType ?? fallback?.agentType ?? this.getDefaultAgentType()).trim() || this.getDefaultAgentType();
		const prompt = String(parsed?.prompt ?? fallback?.prompt ?? '').trim();

		if (!prompt) {
			return undefined;
		}

		return {
			model,
			agentType,
			prompt,
		};
	}

	private parseEmailCommandFallback(email: GmailEmail): ParsedEmailCommand | undefined {
		const body = String(email.body ?? '');
		const normalizedBody = body.trim();
		const subjectPrompt = String(email.subject ?? '').replace(/^cmd:/i, '').trim();

		const modelMatch = body.match(/(?:^|\n)\s*model\s*:\s*(.+?)\s*(?:\n|$)/i);
		const promptMatch = body.match(/(?:^|\n)\s*prompt\s*:\s*([\s\S]+)/i);
		const agentMatch = body.match(/(?:^|\n)\s*(?:agent\s*type|agent)\s*:\s*(.+?)\s*(?:\n|$)/i);
		const candidateLines = [
			subjectPrompt,
			...normalizedBody.split(/\r?\n/),
		]
			.map(line => line.trim())
			.filter(line => !!line)
			.filter(line => !/^(model|prompt|agent\s*type|agent)\s*:/i.test(line));

		const prompt = (promptMatch?.[1] ?? candidateLines[0] ?? normalizedBody).trim();
		if (!prompt) {
			return undefined;
		}

		return {
			model: (modelMatch?.[1] ?? this.getDefaultModel()).trim(),
			prompt,
			agentType: (agentMatch?.[1] ?? this.getDefaultAgentType()).trim(),
		};
	}

	private async captureChatResult(prompt: string, requestStartTime: number): Promise<string | undefined> {
		const storageUri = this._extensionContext.storageUri;
		if (!storageUri) {
			return undefined;
		}

		const debugLogsDir = vscode.Uri.joinPath(storageUri, 'debug-logs');
		const deadline = Date.now() + CHAT_RESULT_TIMEOUT_MS;

		while (Date.now() < deadline) {
			const sessionDirs = await this.readRecentSessionDirectories(debugLogsDir);
			for (const sessionDir of sessionDirs) {
				const mainLogUri = vscode.Uri.joinPath(sessionDir, 'main.jsonl');
				let rawLog: string;
				try {
					const content = await this._fileSystemService.readFile(mainLogUri, true);
					rawLog = this._decoder.decode(content);
				} catch {
					continue;
				}

				const chatResult = this.extractChatResultFromLog(rawLog, prompt, requestStartTime);
				if (chatResult) {
					return chatResult;
				}
			}

			await this.delay(CHAT_RESULT_POLL_INTERVAL_MS);
		}

		return undefined;
	}

	private async readRecentSessionDirectories(debugLogsDir: vscode.Uri): Promise<readonly vscode.Uri[]> {
		let entries: readonly [string, FileType][];
		try {
			entries = await this._fileSystemService.readDirectory(debugLogsDir);
		} catch {
			return [];
		}

		const dirStats = await Promise.all(entries
			.filter(([, type]) => (type & FileType.Directory) === FileType.Directory)
			.map(async ([name]) => {
				const uri = vscode.Uri.joinPath(debugLogsDir, name);
				try {
					const stat = await this._fileSystemService.stat(uri);
					return { uri, mtime: stat.mtime };
				} catch {
					return undefined;
				}
			})
		);

		return dirStats
			.filter((entry): entry is { uri: vscode.Uri; mtime: number } => !!entry)
			.sort((left, right) => right.mtime - left.mtime)
			.slice(0, 8)
			.map(entry => entry.uri);
	}

	private extractChatResultFromLog(rawLog: string, prompt: string, requestStartTime: number): string | undefined {
		const entries = rawLog
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => !!line)
			.map(line => {
				try {
					return JSON.parse(line) as ChatDebugLogEntry;
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is ChatDebugLogEntry => !!entry);

		if (!entries.length) {
			return undefined;
		}

		const normalizedPrompt = prompt.trim();
		const promptEvent = [...entries]
			.reverse()
			.find(entry => {
				const ts = Number(entry.ts ?? 0);
				if (entry.type !== 'user_message' || ts < requestStartTime - 1_000) {
					return false;
				}
				const content = String(entry.attrs?.content ?? '').trim();
				return content === normalizedPrompt || content.includes(normalizedPrompt);
			});

		if (!promptEvent) {
			return undefined;
		}

		const promptTimestamp = Number(promptEvent.ts ?? 0);
		const hasTurnEnded = entries.some(entry => entry.type === 'turn_end' && Number(entry.ts ?? 0) >= promptTimestamp);
		if (!hasTurnEnded) {
			return undefined;
		}

		const responseEntry = [...entries]
			.reverse()
			.find(entry => entry.type === 'agent_response' && Number(entry.ts ?? 0) >= promptTimestamp);

		if (!responseEntry) {
			return undefined;
		}

		const responsePayload = String(responseEntry.attrs?.response ?? '').trim();
		if (!responsePayload) {
			return undefined;
		}

		const extracted = this.extractResponseText(responsePayload);
		if (!extracted) {
			return undefined;
		}

		return extracted.length > MAX_CHAT_RESULT_EMAIL_CHARS
			? `${extracted.slice(0, MAX_CHAT_RESULT_EMAIL_CHARS)}\n\n[Result truncated for email length.]`
			: extracted;
	}

	private extractResponseText(responsePayload: string): string | undefined {
		try {
			const parsed = JSON.parse(responsePayload) as unknown;
			const parts = this.collectResponseTextParts(parsed)
				.map(part => part.trim())
				.filter(part => !!part);
			if (parts.length > 0) {
				return parts.join('\n\n').trim();
			}
		} catch {
			// fall back to raw payload below
		}

		const fallback = responsePayload.trim();
		return fallback || undefined;
	}

	private collectResponseTextParts(value: unknown): string[] {
		if (Array.isArray(value)) {
			return value.flatMap(item => this.collectResponseTextParts(item));
		}

		if (!value || typeof value !== 'object') {
			return [];
		}

		const candidate = value as {
			readonly role?: unknown;
			readonly parts?: unknown;
			readonly type?: unknown;
			readonly content?: unknown;
			readonly text?: unknown;
		};

		if (candidate.role === 'assistant' && Array.isArray(candidate.parts)) {
			return candidate.parts.flatMap(part => this.collectResponseTextParts(part));
		}

		if (candidate.type === 'output_text' && typeof candidate.text === 'string') {
			return [candidate.text];
		}

		if (candidate.type === 'text' && typeof candidate.content === 'string') {
			const content = candidate.content.trim();
			if (!content) {
				return [];
			}

			try {
				const nested = JSON.parse(content) as unknown;
				const nestedParts = this.collectResponseTextParts(nested)
					.map(part => part.trim())
					.filter(part => !!part);
				if (nestedParts.length > 0) {
					return nestedParts;
				}
			} catch {
				// content is plain text
			}

			return [content];
		}

		return [];
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private async sendReply(toEmail: string, subject: string, bodyText: string): Promise<void> {
		if (!this._config || !this._gmailClient) {
			return;
		}

		if (this._config.dryRun) {
			this._logService.info(`[AutomationEmailDaemon][dry-run] Reply to ${toEmail}: ${subject}`);
			return;
		}

		await this._gmailClient.sendGmailEmail(this._config.mailboxEmail, toEmail, subject, bodyText);
	}

	private async writeStateSnapshot(update: EmailCommandRunnerStateUpdate): Promise<void> {
		if (!this._config) {
			return;
		}

		try {
			let existing: EmailCommandRunnerState = {};
			try {
				const content = await this._fileSystemService.readFile(this._config.stateFileUri, true);
				existing = JSON.parse(this._decoder.decode(content)) as EmailCommandRunnerState;
			} catch {
				// ignore parse/read failures and recreate file below
			}

			const merged = {
				...existing,
				lastPollAt: update.lastPollAt ?? existing.lastPollAt,
				activeJob: update.activeJob === undefined ? existing.activeJob : update.activeJob,
			};

			await this._fileSystemService.writeFile(
				this._config.stateFileUri,
				this._encoder.encode(`${JSON.stringify(merged, null, 2)}\n`)
			);
		} catch (error) {
			this._logService.warn(`[AutomationEmailDaemon] Failed to write state snapshot: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
