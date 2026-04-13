/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, suite, test } from 'vitest';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { MockExtensionContext } from '../../../../platform/test/node/extensionContext';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { AutomationOrchestratorAgentProvider } from '../automationOrchestratorAgentProvider';

const ORCHESTRATOR_AGENTS_ENV = 'COPILOT_AUTOMATION_ORCHESTRATOR_AGENTS';
const ORCHESTRATOR_TOOLS_ENV = 'COPILOT_AUTOMATION_ORCHESTRATOR_TOOLS';

suite('AutomationOrchestratorAgentProvider', () => {
	let disposables: DisposableStore;
	let fileSystemService: IFileSystemService;
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let previousAgentsEnv: string | undefined;
	let previousToolsEnv: string | undefined;

	beforeEach(() => {
		previousAgentsEnv = process.env[ORCHESTRATOR_AGENTS_ENV];
		previousToolsEnv = process.env[ORCHESTRATOR_TOOLS_ENV];
		delete process.env[ORCHESTRATOR_AGENTS_ENV];
		delete process.env[ORCHESTRATOR_TOOLS_ENV];

		disposables = new DisposableStore();

		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		const globalStoragePath = path.join(os.tmpdir(), 'automation-orchestrator-agent-test-' + Date.now());
		testingServiceCollection.define(IVSCodeExtensionContext, new SyncDescriptor(MockExtensionContext, [globalStoragePath]));
		accessor = testingServiceCollection.createTestingAccessor();
		disposables.add(accessor);
		instantiationService = accessor.get(IInstantiationService);
		fileSystemService = accessor.get(IFileSystemService);
	});

	afterEach(() => {
		if (previousAgentsEnv === undefined) {
			delete process.env[ORCHESTRATOR_AGENTS_ENV];
		} else {
			process.env[ORCHESTRATOR_AGENTS_ENV] = previousAgentsEnv;
		}

		if (previousToolsEnv === undefined) {
			delete process.env[ORCHESTRATOR_TOOLS_ENV];
		} else {
			process.env[ORCHESTRATOR_TOOLS_ENV] = previousToolsEnv;
		}

		disposables.dispose();
	});

	function createProvider() {
		const provider = instantiationService.createInstance(AutomationOrchestratorAgentProvider);
		disposables.add(provider);
		return provider;
	}

	async function getAgentContent(agent: vscode.ChatResource): Promise<string> {
		const content = await fileSystemService.readFile(agent.uri);
		return new TextDecoder().decode(content);
	}

	test('provideCustomAgents() returns an automation orchestrator agent resource', async () => {
		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, CancellationToken.None);

		assert.equal(agents.length, 1);
		assert.ok(agents[0].uri.path.endsWith('.agent.md'), 'Agent URI should end with .agent.md');
	});

	test('generated content includes automation workflow, subagents, and email approval protocol', async () => {
		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, CancellationToken.None);
		const content = await getAgentContent(agents[0]);

		assert.ok(content.includes('name: Automation Orchestrator'));
		assert.ok(content.includes('api_test_case'));
		assert.ok(content.includes('e2e_test_case'));
		assert.ok(content.includes('e2e_fix_test_case'));
		assert.ok(content.includes('e2e_consolidate_pom'));
		assert.ok(content.includes('test_case_plan'));
		assert.ok(content.includes('[1] Run API smoke suite'));
		assert.ok(content.includes('confirmation from configured sender'));
		assert.ok(content.includes('configured recipient as the sender identity'));
		assert.ok(content.includes('Never respond with "Command not recognized."'));
		assert.ok(content.includes('run <npm-script> [args]'));
		assert.ok(content.includes('runner <alias> [args]'));
		assert.ok(content.includes('node scripts/<file>.cjs [args]'));
	});

	test('generated content defaults to unrestricted tools and agents', async () => {
		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, CancellationToken.None);
		const content = await getAgentContent(agents[0]);

		assert.ok(!content.includes('agents: ['));
		assert.ok(!content.includes('tools: ['));
	});

	test('generated content supports env-configured tool and agent allowlists', async () => {
		process.env[ORCHESTRATOR_AGENTS_ENV] = 'api_test_case, Explore';
		process.env[ORCHESTRATOR_TOOLS_ENV] = 'search, execute, vscode/memory';

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, CancellationToken.None);
		const content = await getAgentContent(agents[0]);

		assert.ok(content.includes('agents: [\'api_test_case\', \'Explore\']'));
		assert.ok(content.includes('tools: [\'search\', \'execute\', \'vscode/memory\']'));
	});
});
