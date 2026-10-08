# Security

- No API keys are stored by this extension, in settings, source files or logs.
- Provider logins stay with the official CLIs (`claude`, `codex`, `agy`), in their own credential stores.
- **Claude accounts.** To switch accounts, Quota Relay moves Claude Code's OAuth login between Claude Code's own
  Keychain items (`Claude Code-credentials` and `Claude Code-credentials-<hash>` for each folder in
  `~/.claude-accounts`); on Linux, between each folder's `.credentials.json`. It never creates its own copy elsewhere.
  Tokens are written through `security -i` on stdin, so they never appear in a process listing.
- The only network calls the extension makes itself are to `api.anthropic.com` (`/api/oauth/usage` and
  `/api/oauth/profile`), with the account's own token, to read its usage and which account a login belongs to.
- `~/.claude-accounts/state.json` and `usage.json` hold account names, emails and usage percentages, never tokens.
