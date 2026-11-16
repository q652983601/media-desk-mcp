# Changelog

## Unreleased

### 2026-11-16

[Draft PR #1](https://github.com/q652983601/media-desk-mcp/pull/1)

- Added a CLI configuration dialog under Settings for Codex, Claude Code, Kimi and MiniMax mmx. Enable tools, set executable paths and comma-separated model IDs, detect installation and apply changes immediately.
- Persist CLI settings in the service data directory with revision conflict checks, atomic writes and protection during active CLI generation. Existing environment variables seed initial settings.
- Added Claude print-JSON and MiniMax Messages-JSON adapters using stdin and the existing bounded process lifecycle. MiniMax uses the installed mmx command and its own local authentication configuration.
- Kept all 51 upstream frontend and asset files intact. The standalone shell adds the settings entry and reuses the original dialog and theme.
- Local validation passed all 153 tests, build and the 51-file upstream integrity check. Browser verification covered opening configuration, enabling all four CLIs, saving, reopening and switching the selected provider. Added adapter and configuration regression tests. Actual account authentication and model generation remain pending device verification. Local deployment evidence is stored in the owning runtime.

- Added a Magpie provider tab with live text-model/routing-group discovery, search, selection and metadata-driven reasoning effort. Reuses the Chat Completions execution bridge.
- Persist gateway settings with revision checks, active-call protection and origin-bound secret reuse. Selecting a Magpie model applies to assistant and production workflows.
- Added Magpie regression coverage for catalog normalization, secret redaction, settings conflicts, persistence, generation request mapping and active-call guards.
- Magpie candidate local validation passed 159/159 tests, frontend build and 51-file integrity verification. Real local model discovery and browser configuration/save/reopen passed. Actual generation remains pending.

- Added native CLI mode and explicit assistant runtime/model selection in local CLI settings. Legacy configuration keeps its previous mode, and unrelated saves preserve the assistant choice.
- Added current Kimi ACP configOptions model selection while retaining legacy protocol handling.
- Native Kimi, Codex and MiniMax CLI live checks passed. Normal assistant entry passed through Kimi K3.1 Pro. Native Claude login is pending on the deployment machine.
- Native CLI candidate validation passed 163/163 local tests, frontend build and integrity checks. Independent source and desktop/mobile review found no remaining blockers.
