<h1 align="center">QUI</h1>

<p align="center"><a href="./README.md">English</a></p>

<p align="center">基于 <a href="https://github.com/pingdotgg/t3code">T3 Code</a> 的非官方社区版桌面应用。</p>

> **非官方项目与商标声明**
>
> QUI 基于开源的 [T3 Code](https://github.com/pingdotgg/t3code) 开发，由社区维护。T3 Tools, Inc. 与本项目无关联，也未赞助或背书。
>
> - 源码采用 [MIT 许可证](./LICENSE)，保留原版权声明 `Copyright (c) 2026 T3 Tools Inc.`。
> - QUI 使用自己的名称、图标和桌面应用 ID `local.qui.desktop`。上游商标与品牌要求见 [TRADEMARK.md](./TRADEMARK.md)。

## QUI 是什么？

QUI 是一款本地优先的编码智能体管理应用，支持 Claude Code、Codex、Antigravity / Gemini、Cursor、OpenCode，以及兼容 ACP 的智能体。它在 T3 Code 的基础上加入了本地插件和通过官方 CLI 查询额度的功能。

### 主要区别

1. **独立品牌和数据目录**  
   QUI 使用独立的桌面和网页图标，并将本地数据保存在 `~/.qui`（Windows 上为 `%USERPROFILE%\.qui`），可与官方 T3 Code 并存。
2. **通过官方 CLI 查询 Antigravity（Gemini）额度**  
   QUI 在伪终端（PTY）中运行官方 `agy` CLI 的 `/usage` 命令，读取订阅额度。旧版直接读取 OAuth 凭据和通过 CLIProxyAPI 代查 Antigravity 额度的路径已移除。使用前需安装 `agy`，并在终端运行 `agy` 完成登录。实现见 [antigravityCliUsageLimits.ts](./apps/server/src/provider/antigravityCliUsageLimits.ts)。
3. **内置本地插件**  
   - `usage-hud` 显示 Codex、Gemini、Claude / GPT 的 5 小时和周额度，以及上下文占用、Token 吞吐量和首 Token 延迟（TTFT）。
   - `sidebar-enhancer` 提供侧栏界面增强。
   - 插件位于 [builtin-plugins](./apps/desktop/resources/builtin-plugins/)，由 [本地插件加载器](./apps/server/src/localPlugins.ts) 加载。桌面[打包脚本](./scripts/build-desktop-artifact.ts)会自动将其纳入安装包。

## 从源码构建

### 环境要求

- Node.js，所需版本见 [package.json](./package.json) 中的 `engines`。
- pnpm 12.x 和 Vite+（`vp`）。
- 构建 Windows x64 安装包需要 Rust 的 `x86_64-pc-windows-msvc` 目标、供 `node-gyp` 使用的 Python 3，以及包含 C++ 工具链、Windows SDK 和 Spectre 缓解库的 Visual Studio Build Tools。已有预构建的 `resource-monitor` 时，可设置 `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1` 复用。详见 [Windows 安装包构建要求](./docs/operations/00_development.md#windows-installer-prerequisites)。

### 安装依赖并运行开发版

```bash
pnpm install
vp run dev:desktop
```

### 构建 Windows 安装包

```bash
pnpm install
vp run dist:desktop:win:x64
```

生成的 NSIS 安装包（`.exe`）位于 `release/`。

### 运行相关测试

```bash
vp test run apps/server/src/provider/antigravityCliUsageLimits.test.ts apps/server/src/usage/cliproxyApi.test.ts apps/server/src/usage/UsageLimitSources.test.ts
```

## 文档与上游

- [T3 Code 文档](./docs/README.md)
- [T3 Code 上游仓库](https://github.com/pingdotgg/t3code)
- [MIT 许可证](./LICENSE) · [上游商标与品牌要求](./TRADEMARK.md)
