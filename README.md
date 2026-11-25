<h1 align="center">QUI</h1>

<p align="center"><a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">An unofficial, community-maintained desktop build based on <a href="https://github.com/pingdotgg/t3code">T3 Code</a>.</p>

> **Trademark & Unofficial Fork Notice**
>
> **QUI is an unofficial derivative project** built from the open-source [T3 Code](https://github.com/pingdotgg/t3code) codebase and is **not affiliated with, sponsored by, or endorsed by T3 Tools, Inc.**
>
> - **Source License**: The source code is licensed under the [MIT License](./LICENSE) (`Copyright (c) 2026 T3 Tools Inc.`).
> - **Upstream Repository**: [`https://github.com/pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
> - **Branding**: All T3 Code names, wordmarks, logos, and application icons have been replaced with QUI branding (`local.qui.desktop`) in accordance with [TRADEMARK.md](./TRADEMARK.md).

## What is QUI?

QUI is a local-first desktop control plane for coding agents (Claude Code, Codex, Antigravity / Gemini, Cursor, OpenCode, and ACP-compatible agents), forked from T3 Code with local plugins and compliant quota integration.

### Key Differences from Upstream T3 Code

1. **Independent Branding & Data Isolation**
   - Uses `QUI` product name, distinct desktop/web icons, and app ID `local.qui.desktop` (`~/.qui` userdata directory) so it does not conflict with official T3 Code installations.
2. **Compliant Antigravity (Gemini) Quota Probing**
   - Removed direct OAuth credential reading (`antigravityUsageLimits.ts`) and CLIProxyAPI Antigravity proxy quota requests (`cliproxyApi.ts`).
   - Instead, probes subscription limits compliantly by running the official `agy` CLI `/usage` command in a PTY ([`antigravityCliUsageLimits.ts`](./apps/server/src/provider/antigravityCliUsageLimits.ts)).
   - Requires `agy` to be installed and signed in on your machine (`agy` in a terminal).
3. **Built-in Local Plugins**
   - [`apps/server/src/localPlugins.ts`](./apps/server/src/localPlugins.ts) + [`apps/desktop/resources/builtin-plugins/`](./apps/desktop/resources/builtin-plugins/)
   - **`usage-hud`**: Displays 5-hour and weekly subscription quotas (Codex, Gemini, Claude / GPT), context window breakdown, and token throughput/TTFT metrics.
   - **`sidebar-enhancer`**: Sidebar UI enhancements.
   - Packaged automatically into desktop builds via [`scripts/build-desktop-artifact.ts`](./scripts/build-desktop-artifact.ts).

## Build from Source (Same as Official QUI Installer)

### Prerequisites

- **Node.js** (see `engines` in [`package.json`](./package.json)) & **pnpm** (`12.x`)
- **Vite+** (`vp` / `pnpm install`)
- **Windows installer builds**: Rust (`x86_64-pc-windows-msvc`), Python 3 (for `node-gyp`), and Visual Studio Build Tools with C++, Windows SDK, and Spectre-mitigated libraries (or set `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1` if reusing a prebuilt `resource-monitor`). See [`docs/operations/00_development.md`](./docs/operations/00_development.md#windows-installer-prerequisites).

### Install & Run in Dev Mode

```bash
pnpm install
vp run dev:desktop
```

### Build Windows Installer (`.exe`)

```bash
pnpm install
vp run dist:desktop:win:x64
```

The built NSIS installer is output under `release/`.

### Run Tests

```bash
vp test run apps/server/src/provider/antigravityCliUsageLimits.test.ts apps/server/src/usage/cliproxyApi.test.ts apps/server/src/usage/UsageLimitSources.test.ts
```

## Documentation & Upstream

- Upstream T3 Code documentation: [`docs/README.md`](./docs/README.md)
- Upstream T3 Code repository: [`https://github.com/pingdotgg/t3code`](https://github.com/pingdotgg/t3code)

## License & Trademarks

- Source code is licensed under the [MIT License](./LICENSE).
- Original copyright belongs to **T3 Tools Inc.** (`Copyright (c) 2026 T3 Tools Inc.`).
- See [`TRADEMARK.md`](./TRADEMARK.md) for upstream trademark and branding requirements.
