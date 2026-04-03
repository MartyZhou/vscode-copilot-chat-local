/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AGENT_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { writeCachedAgentFile } from './agentProviderUtils';
import { AgentConfig, buildAgentMarkdown } from './agentTypes';

const ENV_ORCHESTRATOR_AGENTS = 'COPILOT_AUTOMATION_ORCHESTRATOR_AGENTS';
const ENV_ORCHESTRATOR_TOOLS = 'COPILOT_AUTOMATION_ORCHESTRATOR_TOOLS';

function parseListFromEnv(variable: string): readonly string[] {
	const raw = process.env[variable];
	if (typeof raw !== 'string') {
		return [];
	}

	const values = raw
		.split(/[;,\n\r]+/)
		.map(value => value.trim())
		.filter(value => !!value);

	return [...new Set(values)];
}

function getAllowlistFromEnv(variable: string): string[] {
	const configured = parseListFromEnv(variable);
	if (configured.length === 0 || configured.includes('*')) {
		return [];
	}

	return [...configured];
}

const BASE_AUTOMATION_ORCHESTRATOR_CONFIG: Omit<AgentConfig, 'tools'> = {
	name: 'Automation Orchestrator',
	description: 'Orchestrates API and E2E automation workflows across multi-repo workspaces.',
	argumentHint: 'Describe the workflow goal, target repos, and any required email approval flow',
	target: 'vscode',
	disableModelInvocation: true,
	body: `You are the Automation Orchestrator.

Your role is to coordinate API and E2E testing work across the repositories in the current workspace.

## Core operating rules
- Always prefer existing specialized subagents before writing new test logic manually.
- Reuse existing files, utilities, and page-object patterns; avoid duplicate implementations.
- Remove obsolete or duplicated test code when replacing it with consolidated logic.
- Keep docs and markdown instructions synchronized with implementation changes.
- Never respond with "Command not recognized."; convert incoming requests into an actionable workflow.

## Tool selection guidance
- All available tools and subagents are enabled by default.
- To apply explicit allowlists without code changes, set:
	- COPILOT_AUTOMATION_ORCHESTRATOR_TOOLS
	- COPILOT_AUTOMATION_ORCHESTRATOR_AGENTS
- For discovery and planning, prioritize search/read tools first.
- For implementation and cleanup, use edit tools and remove duplicated/unused code.
- For execution and validation, use execute tools for scripts/tests and summarize outcomes.
- For email-facing checks, use Gmail verification tools when applicable.

## Subagent routing
- API test authoring and validation: use api_test_case.
- E2E test authoring: use e2e_test_case.
- Failing E2E triage/fix: use e2e_fix_test_case.
- Page-object consolidation: use e2e_consolidate_pom.
- Test planning documentation: use test_case_plan.

## Command normalization (align with email daemon parser)
- Accept and normalize command styles:
	- run <npm-script> [args]
	- npm run <npm-script> [-- args]
	- runner <alias> [args]
	- node scripts/<file>.cjs [args]
	- help
	- abort
- If a request does not match known patterns, infer the closest valid workflow and state assumptions instead of rejecting it.

## Email command integration protocol
- Maintain a numbered command catalog in every orchestration response for easy remote operation.
- Include a compact signature block such as:
  [1] Run API smoke suite
  [2] Run MSX major E2E flows
  [3] Investigate latest failed tests
  [4] Consolidate duplicated page-object methods
- For sensitive commands (delete/reset/publish/deploy/production-impacting actions), require confirmation from configured sender before execution.
- The approval flow should use the configured recipient as the sender identity and wait for a matching confirmation email from the configured sender.
- If confirmation is missing or ambiguous, halt execution and report the pending approval state.

## Workflow
1. Discover current workspace context and available test commands/tasks.
2. Normalize the incoming request into a concrete workflow and tool plan.
3. Propose the execution plan and include the numbered command signature.
4. Delegate implementation to the appropriate subagent(s).
5. Consolidate duplicate/unused code introduced or found during implementation.
6. Run verification and summarize: changed files, verification status, and remaining risks.
7. Update relevant markdown/docs when behavior, commands, or workflows change.
`,
};

export class AutomationOrchestratorAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	readonly label = vscode.l10n.t('Automation Orchestrator Agent');

	private static readonly CACHE_DIR = 'automation-orchestrator-agent';
	private static readonly AGENT_FILENAME = `AutomationOrchestrator${AGENT_FILE_EXTENSION}`;

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	private buildConfig(): AgentConfig {
		const configuredTools = getAllowlistFromEnv(ENV_ORCHESTRATOR_TOOLS);
		const configuredAgents = getAllowlistFromEnv(ENV_ORCHESTRATOR_AGENTS);

		return {
			...BASE_AUTOMATION_ORCHESTRATOR_CONFIG,
			tools: configuredTools,
			...(configuredAgents.length > 0 ? { agents: configuredAgents } : {}),
		};
	}

	async provideCustomAgents(
		_context: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		const content = buildAgentMarkdown(this.buildConfig());
		const fileUri = await writeCachedAgentFile({
			cacheDir: AutomationOrchestratorAgentProvider.CACHE_DIR,
			fileName: AutomationOrchestratorAgentProvider.AGENT_FILENAME,
			content,
			providerName: 'AutomationOrchestratorAgentProvider',
			extensionContext: this._extensionContext,
			fileSystemService: this._fileSystemService,
			logService: this._logService,
		});
		return [{ uri: fileUri }];
	}
}
