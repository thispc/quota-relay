# Quota Relay

**Run two or more Claude subscriptions as one, and hand work on as each one runs out.**

Quota Relay keeps every Claude client on your machine on the account that has room: sign each subscription in once through the browser, then switch with a click in the status bar, or let it rotate on its own as windows fill and reset. It also watches Codex and Antigravity quotas, steps Claude down a model ladder as the pool empties, and delegates to another provider when every Claude account is spent.

---

## ✨ Key Features

* **Real-time Quota Telemetry**:
  * **Claude Code**: Live 5-hour and 7-day rate-limit tracking via official CLI calls with in-memory caching and reset countdowns.
  * **Google Antigravity**: Dual-group tracking across native Gemini models and 3P models (Claude 3.7 / GPT-4o), plus local conversation and step counts.
  * **OpenAI Codex**: 5-hour and 7-day token utilization and request tracking.
* **Intelligent PowerSaver & Model Ladders**:
  * Dynamically steps down models as your window empties (e.g. `≥70% fable` &rarr; `≥50% opus` &rarr; `≥30% sonnet`).
  * When Claude reaches your safety floor (e.g. `<30%`), tasks automatically delegate to Codex to preserve Claude for complex reasoning.
* **Clean, Modern Status Bar (No Clutter)**:
  * Replaces awkward ASCII block meters with modern micro-badges color-coded by burn pace (`charts.green`, `charts.yellow`, `charts.red`).
  * Multiple visual density modes:
    * **`separated` (Default)**: Clean micro-badges: `⚡ Claude (opus) | 🟢 Claude 47% | 🟢 Codex 88% | 🟢 AGY 89%`.
    * **`consolidated`**: A single compact pill: `⚡ Claude 47% (opus) · Codex 88% · AGY 89%`.
    * **`active-only`**: Minimalist mode showing only the current active worker and model.
* **Interactive Quota QuickPick**:
  * Click any status bar item or run `Quota Relay: Show Model Quota & Usage` to view live quotas, countdowns, one-click refreshes, and worker switching.
* **Multi-Turn Agent Chat Panel**:
  * Unified workspace chat panel with Markdown rendering, syntax-highlighted code blocks, and one-click code copying.
* **100% Local & Secure**:
  * Never embeds API keys or private tokens. All authentication is handled directly by your locally installed official CLIs (`claude`, `codex`, `agy`).

---

## 👥 Two Claude subscriptions, used as one

Click the **$(account) Claude** item in the status bar (or run **Quota Relay: Claude Accounts**).

* **Add an account**: pick *Add a Claude account…*, name it, and finish the login in the browser window that opens. The login you already have in Claude Code becomes your first account automatically.
* **Switch by hand**: pick an account in the menu, or press `Cmd+Alt+A` (`Ctrl+Alt+A`) to go to the next one.
* **Auto-switch** (on by default): the active account is used until its tighter window (5-hour or weekly) is under 5%, then everything moves to the account with room. While you use one account, the other refills, so they take turns. When choosing between fresh accounts, the one whose weekly allowance resets soonest goes first, because what it has left would be lost at the reset. If Claude hits its limit in the middle of a task, the task moves to the next account and runs again there, and only falls back to Codex when no account has room.

A switch applies to **every Claude client on this Mac**: the terminal, the Claude Code VS Code extension, and this plugin's workers. Running sessions pick up the new login within about 30 seconds. History, settings, skills and MCP logins are shared, because only the Claude login moves.

How it works: each account has a folder in `~/.claude-accounts/<name>`, and Claude Code keeps that folder's login in its own Keychain item. A switch parks the outgoing login in its own item and moves the incoming one into the default `Claude Code-credentials` item that every client reads. Tokens are written to the Keychain through stdin, never on a command line, and they never leave your machine except to Anthropic's own usage endpoint.

| Setting | Default | |
| :--- | :---: | :--- |
| `quotaRelay.accounts.autoSwitch` | `true` | Move to the next account automatically |
| `quotaRelay.accounts.switchBelowPercent` | `5` | Switch when the active account has this much or less left |
| `quotaRelay.accounts.switchMargin` | `10` | Only switch to an account with at least this many points more |

---

## 🚀 Quick Start

### 1. Requirements
Ensure at least one of the official CLIs is installed and signed in:
* **Claude Code**: `npm i -g @anthropic-ai/claude-code` (run `claude`)
* **Google Antigravity**: Official `agy` CLI installed in PATH or `~/.gemini/bin/agy`
* **OpenAI Codex**: `codex` CLI

### 2. Status Bar Modes
Customize the status bar layout in VS Code Settings (`Cmd + ,`):
```json
"quotaRelay.statusBarLayout": "separated" // Options: "separated" | "consolidated" | "active-only"
```

### 3. Model Ladder Configuration
Configure your custom model ladder in `settings.json`:
```json
"quotaRelay.powerSaver.enabled": true,
"quotaRelay.powerSaver.saverBelowPercent": 30,
"quotaRelay.powerSaver.ladder": [
  { "atLeast": 70, "model": "fable" },
  { "atLeast": 50, "model": "opus" },
  { "atLeast": 30, "model": "sonnet" }
]
```

---

## 🕹️ Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `quotaRelay.accounts` | **Quota Relay: Claude Accounts** | Switch, add (browser sign-in), re-sign-in, rename or remove accounts |
| `quotaRelay.nextAccount` | **Quota Relay: Switch to Next Claude Account** | `Cmd+Alt+A` |
| `quotaRelay.showQuota` | **Quota Relay: Show Model Quota & Usage** | Opens the interactive QuickPick modal with quotas and actions |
| `quotaRelay.chat` | **Quota Relay: Chat** | Opens the webview multi-turn agent chat panel |
| `quotaRelay.newChat` | **Quota Relay: New Conversation** | Clears the active chat thread |
| `quotaRelay.runTask` | **Quota Relay: Run Task** | Dispatches a prompt with workspace context to a worker |
| `quotaRelay.cancelTask` | **Quota Relay: Cancel Active Task** | Gracefully terminates running background agent CLI processes |
| `quotaRelay.showWorkers` | **Quota Relay: Show Worker Status** | Displays worker lifecycle statistics and completion counts |
| `quotaRelay.checkAuth` | **Quota Relay: Check CLI Authentication** | Tests local authentication credentials for all providers |
| `quotaRelay.openWorkerTerminal` | **Quota Relay: Open Worker Terminal** | Opens an interactive terminal for provider logins |

*Settings saved under the earlier names (`aiSwitchboard.*`, `localCliWorkers.*`) are still read.*

---

## 📦 Building & Publishing to VS Code Marketplace

### Local Build:
```bash
npm run compile
npm test
npm run package   # Generates quota-relay-0.1.0.vsix
```

### Installing locally:
```bash
code --install-extension quota-relay-0.1.0.vsix --force
```

### Publishing to VS Code Marketplace:
1. Create a publisher account at [Visual Studio Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Generate an Azure DevOps Personal Access Token (PAT) with **Marketplace (Manage)** scope.
3. Update `"publisher"` in `package.json` with your publisher ID.
4. Publish:
   ```bash
   npx @vscode/vsce publish -p <YOUR_PERSONAL_ACCESS_TOKEN>
   ```
   *(Or drag-and-drop the generated `.vsix` directly into the Marketplace web portal).*

---

## 📄 License
MIT © Quota Relay Contributors
