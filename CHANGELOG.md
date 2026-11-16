# Changelog

## Unreleased

### 2026-11-16

- Added a CLI configuration dialog under Settings for Codex, Claude Code, Kimi and MiniMax mmx. Enable tools, set executable paths and comma-separated model IDs, detect installation and apply changes immediately.
- Persist CLI settings in the service data directory with revision conflict checks, atomic writes and protection during active CLI generation. Existing environment variables seed initial settings.
- Added Claude print-JSON and MiniMax Messages-JSON adapters using stdin and the existing bounded process lifecycle. MiniMax uses the installed mmx command and its own local authentication configuration.
- Kept all 51 upstream frontend and asset files intact. The standalone shell adds the settings entry and reuses the original dialog and theme.
- Local validation passed all 153 tests, build and the 51-file upstream integrity check. Browser verification covered opening configuration, enabling all four CLIs, saving, reopening and switching the selected provider. Added adapter and configuration regression tests. Actual account authentication and model generation remain pending device verification. Local deployment evidence is stored in the owning runtime.
