# Automation Orchestrator

This repository is customized with a dedicated custom agent named **Automation Orchestrator** that coordinates API and E2E testing workflows across multi-repo workspaces.

## Workspace Scope

The orchestrator is designed for these repositories in one VS Code workspace:

- E2E and API test case repository
- Front end code repository
- Back end code repository

## What It Coordinates

The orchestrator routes work to existing specialized agents instead of duplicating logic:

- `api_test_case` for API test generation and validation
- `e2e_test_case` for new E2E tests
- `e2e_fix_test_case` for triage and stabilization
- `e2e_consolidate_pom` for removing duplicated page-object code
- `test_case_plan` for drafting test planning documents

## Email Command Protocol

The orchestrator uses a remote-command style protocol aligned with the existing email runner pattern:

1. Present a numbered command signature in responses for easy remote ordering.
2. Map selected command numbers to concrete run/test workflows.
3. Require explicit approval before sensitive operations (delete/reset/publish/deploy/production-impacting commands).
4. Approval identity policy is configurable via daemon settings:
   - `allowedSender`
   - `mailboxEmail`
   Optional environment overrides are also supported:
   - `COPILOT_AUTOMATION_DAEMON_ALLOWED_SENDER`
   - `COPILOT_AUTOMATION_DAEMON_MAILBOX_EMAIL`
5. If approval is absent or ambiguous, execution stays blocked.

## Numbered Command Signature (Example)

- [1] Run API smoke suite
- [2] Run major E2E flows
- [3] Investigate latest failed tests
- [4] Consolidate duplicated page-object methods

## Email Daemon (`AutomationEmailDaemonContribution`)

The extension includes a background daemon that polls the command mailbox and routes work into the chat panel automatically.

### How it works

1. On activation, the daemon discovers a workspace folder containing the Gmail client path.
   - Default path: `tools/runners/src/auto-healer/gmail-client.cjs`
   - Override with: `COPILOT_AUTOMATION_DAEMON_GMAIL_CLIENT_RELATIVE_PATH`
2. It reads configuration from `reports/email-command-runner-state.json` (mailbox, allowed sender, model, poll interval, dryRun).
3. It loads the Gmail client via `require()` to list, read, mark-read, and send emails.
4. Every poll cycle it fetches unread `cmd:` emails from the allowed sender.
5. Each email is parsed using a non-premium language model (prefers `gpt-5-mini`, falls back to `gpt-4o-mini` or regex-based extraction) to extract:
   - `model` - which model the requester wants
   - `prompt` - the task description
   - `agentType` - which agent to route to
6. Free-form command styles are accepted (for example: `run ...`, `npm run ...`, `runner ...`, `node ...`, `help`, `abort`), then normalized into an actionable prompt.
7. The daemon routes the request to the chat panel via `workbench.action.chat.open` in agent mode and sends **prompt-only** chat input (`query: prompt`) while passing model/agent metadata separately.
8. The daemon polls debug session logs and captures the assistant result from the matching chat turn.
9. The reply email includes configured model, configured agent type, prompt, and the captured chat result (or a timeout message if the result is not available yet).
10. Premium models are automatically downgraded to `gpt-5-mini` for daemon-initiated requests.

### Key files

| File | Purpose |
|------|---------|
| `src/extension/agents/vscode-node/automationEmailDaemonContribution.ts` | Daemon implementation |
| `src/extension/agents/vscode-node/automationOrchestratorAgentProvider.ts` | Custom orchestrator agent provider |
| `src/extension/extension/vscode-node/contributions.ts` | Registration in always-on node contributions |
| `{target_test_repo}/reports/email-command-runner-state.json` | Runtime configuration and state |
| `{target_test_repo}/tools/runners/src/auto-healer/gmail-client.cjs` | Gmail OAuth2 client |

### Environment overrides

- `COPILOT_AUTOMATION_DAEMON_MAILBOX_EMAIL`
- `COPILOT_AUTOMATION_DAEMON_ALLOWED_SENDER`
- `COPILOT_AUTOMATION_DAEMON_PARSE_MODEL`
- `COPILOT_AUTOMATION_DAEMON_AGENT_TYPE`
- `COPILOT_AUTOMATION_DAEMON_POLL_INTERVAL_MS`
- `COPILOT_AUTOMATION_DAEMON_STATE_FILE_RELATIVE_PATH`
- `COPILOT_AUTOMATION_DAEMON_GMAIL_CLIENT_RELATIVE_PATH`
- `COPILOT_AUTOMATION_ORCHESTRATOR_AGENTS` (comma/semicolon/newline-delimited allowlist)
- `COPILOT_AUTOMATION_ORCHESTRATOR_TOOLS` (comma/semicolon/newline-delimited allowlist)

### Command email format

- **From**: `{configured sender}` (or the configured `allowedSender`)
- **To**: `{configured recipient}` (or the configured `mailboxEmail`)
- **Subject**: must start with `cmd:`
- **Body**: either explicit fields (`model:`, `agent type:`, `prompt:`) or a free-form command/request

Supported command styles include:

- `run <npm-script> [args]`
- `npm run <npm-script> [-- args]`
- `runner <alias> [args]`
- `node scripts/<file>.cjs [args]`
- `help`
- `abort`

## Verification

Use this workspace to verify the extension behavior:

`<path-to-your-automation-verify-workspace>.code-workspace`

Use your local shell profile, `.env`, or task runner configuration to set machine-specific workspace paths.

Verification checklist:

1. Build the extension: `npm run compile`.
2. Launch VS Code Insiders:
   ```powershell
   code-insiders --new-window --extensionDevelopmentPath="<path-to-vscode-copilot-chat-local>" --user-data-dir="<path-to-vscode-copilot-chat-local>/.vscode-ext-debug" "<path-to-your-automation-verify-workspace>.code-workspace"
   ```
   Notes:
   - Use a persistent `--user-data-dir` to avoid the CLI forwarding args to an existing instance and immediately terminating.
   - Reuse the same debug profile directory across runs so auth/session state stays stable.
3. Wait for extension activation.
4. Open chat and choose the **Automation Orchestrator Agent**.
5. Request API and E2E orchestration tasks and confirm:
   - Specialized subagents are used.
   - Numbered command signatures are returned.
   - Sensitive commands are held behind explicit approval.
6. Send a `cmd:` email and verify the daemon picks it up, opens chat, and replies with chat results.
7. Validate that docs/instructions remain aligned with behavior.
