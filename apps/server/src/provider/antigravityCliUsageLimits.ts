import * as NodeModule from "node:module";

import type {
  AntigravitySettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";

const DEFAULT_PTY_TIMEOUT_MS = 20_000;
const PROMPT_FALLBACK_SEND_MS = 3_500;
const COMMAND_INPUT_SETTLE_MS = 350;
const OUTPUT_SETTLE_MS = 450;

const requireForNodePty = NodeModule.createRequire(import.meta.url);

type NodePtyModule = typeof import("node-pty");

function loadNodePty(): NodePtyModule {
  return requireForNodePty("node-pty") as NodePtyModule;
}

export function stripAntigravityCliAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, (sequence) => {
      if (sequence.endsWith("H") || sequence.endsWith("f")) return "\n";
      return "";
    })
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\r/g, "");
}

function parseRefreshDurationMs(line: string): number | undefined {
  const match = /\bRefreshes in\s+(.+)$/i.exec(line.trim());
  if (!match) return undefined;
  const body = match[1]!;
  let totalMs = 0;
  let matched = false;
  for (const part of body.matchAll(/(\d+)\s*([dhms])/gi)) {
    const value = Number.parseInt(part[1]!, 10);
    const unit = part[2]!.toLowerCase();
    if (!Number.isFinite(value)) continue;
    matched = true;
    if (unit === "d") totalMs += value * 24 * 60 * 60_000;
    else if (unit === "h") totalMs += value * 60 * 60_000;
    else if (unit === "m") totalMs += value * 60_000;
    else if (unit === "s") totalMs += value * 1_000;
  }
  return matched && totalMs > 0 ? totalMs : undefined;
}

interface QuotaGroupMeta {
  readonly idPrefix: string;
  readonly labelPrefix: string;
}

function parseGroupHeader(line: string): QuotaGroupMeta | undefined {
  const trimmed = line.trim();
  if (!/^[A-Z0-9][A-Z0-9\s/&+-]*MODELS$/i.test(trimmed)) return undefined;
  const upper = trimmed.toUpperCase();
  if (upper.includes("GEMINI")) {
    if (upper.includes("ARGON")) return { idPrefix: "gemini-argon", labelPrefix: "Gemini Argon" };
    if (upper.includes("CARBON"))
      return { idPrefix: "gemini-carbon", labelPrefix: "Gemini Carbon" };
    return { idPrefix: "gemini", labelPrefix: "Gemini" };
  }
  if (upper.includes("CLAUDE") || upper.includes("GPT")) {
    return { idPrefix: "claude-gpt", labelPrefix: "Claude / GPT" };
  }
  const slug = upper
    .replace(/\s+MODELS$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return undefined;
  return {
    idPrefix: slug,
    labelPrefix: trimmed.replace(/\s+MODELS$/i, ""),
  };
}

interface WindowKindMeta {
  readonly idSuffix: string;
  readonly labelSuffix: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins: number | undefined;
}

function parseWindowHeader(line: string): WindowKindMeta | undefined {
  const trimmed = line.trim();
  if (/^Weekly Limit Remaining$/i.test(trimmed)) {
    return {
      idSuffix: "weekly",
      labelSuffix: "Weekly",
      kind: "weekly",
      windowDurationMins: 7 * 24 * 60,
    };
  }
  if (/^Five Hour Limit Remaining$/i.test(trimmed)) {
    return {
      idSuffix: "5h",
      labelSuffix: "5h",
      kind: "session",
      windowDurationMins: 5 * 60,
    };
  }
  if (/^Monthly Limit Remaining$/i.test(trimmed)) {
    return {
      idSuffix: "monthly",
      labelSuffix: "Monthly",
      kind: "monthly",
      windowDurationMins: 30 * 24 * 60,
    };
  }
  return undefined;
}

export function isAntigravityCliSignedOutOutput(rawText: string): boolean {
  const cleaned = stripAntigravityCliAnsi(rawText);
  return (
    /You are currently not signed in\./i.test(cleaned) ||
    /Select login method:/i.test(cleaned) ||
    /Open the URL below in your browser:/i.test(cleaned)
  );
}

/**
 * Parses the interactive `agy` CLI `/usage` TUI panel into `ServerProviderUsageLimits`.
 * Returns `unavailable` when no quota windows could be extracted.
 */
export function parseAntigravityCliUsageOutput(
  rawText: string,
  requestedAtMs: number,
): ServerProviderUsageLimits {
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs));
  const cleaned = stripAntigravityCliAnsi(rawText);
  const windows = new Map<string, ServerProviderUsageWindow>();

  let currentGroup: QuotaGroupMeta | undefined;
  let currentWindow: WindowKindMeta | undefined;
  let lastWindowId: string | undefined;

  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const group = parseGroupHeader(line);
    if (group) {
      currentGroup = group;
      currentWindow = undefined;
      lastWindowId = undefined;
      continue;
    }

    const windowMeta = parseWindowHeader(line);
    if (windowMeta && currentGroup) {
      currentWindow = windowMeta;
      lastWindowId = undefined;
      continue;
    }

    if (currentGroup && currentWindow) {
      if (!/上下文|shortcuts|\bcontext\b/i.test(line)) {
        const percentMatch = /[\]█░▓▒]\s*(\d+(?:\.\d+)?)%/.exec(line);
        if (percentMatch) {
          const remaining = Number.parseFloat(percentMatch[1]!);
          if (Number.isFinite(remaining)) {
            const id = `${currentGroup.idPrefix}-${currentWindow.idSuffix}`;
            const usedPercent = Math.round(clampPercent(100 - remaining) * 100) / 100;
            windows.set(id, {
              id,
              kind: currentWindow.kind,
              label: `${currentGroup.labelPrefix} ${currentWindow.labelSuffix}`,
              usedPercent,
              ...(currentWindow.windowDurationMins === undefined
                ? {}
                : { windowDurationMins: currentWindow.windowDurationMins }),
            });
            lastWindowId = id;
            continue;
          }
        }
      }
    }

    if (lastWindowId) {
      if (/^Quota available$/i.test(line)) {
        lastWindowId = undefined;
        continue;
      }
      const refreshMs = parseRefreshDurationMs(line);
      if (refreshMs !== undefined) {
        const existing = windows.get(lastWindowId);
        if (existing) {
          windows.set(lastWindowId, {
            ...existing,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs + refreshMs)),
          });
        }
        lastWindowId = undefined;
      }
    }
  }

  if (windows.size === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: isAntigravityCliSignedOutOutput(cleaned)
        ? "Antigravity CLI is not signed in. Run `agy` in a terminal to sign in."
        : "Could not read quota from Antigravity CLI /usage.",
    });
  }

  return makeUsageLimits({
    checkedAt,
    windows: windows.values(),
  });
}

function hasCompleteUsageOutput(cleaned: string): boolean {
  const hasLimit = /(?:Weekly|Five Hour|Monthly) Limit Remaining/i.test(cleaned);
  const hasPercent = /[\]█░▓▒]\s*\d+(?:\.\d+)?%/.test(cleaned);
  const hasStatus = /Refreshes in\s+\d+|Quota available/i.test(cleaned);
  return hasLimit && hasPercent && hasStatus;
}

function isCliPromptReady(cleaned: string): boolean {
  return /\?\s*for shortcuts/i.test(cleaned) || /\b0\s+(?:running|运行中)\b/i.test(cleaned);
}

function captureAntigravityCliUsageRaw(input: {
  readonly ptyModule: NodePtyModule;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<string, string> {
  return Effect.callback<string, string>((resume) => {
    let settled = false;
    let raw = "";
    let usageSent = false;
    let term: import("node-pty").IPty | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let submitTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      if (submitTimer) {
        clearTimeout(submitTimer);
        submitTimer = undefined;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      try {
        term?.write("\x1b");
      } catch {
        // Ignore PTY write errors during teardown.
      }
      try {
        term?.kill();
      } catch {
        // Ignore PTY kill errors during teardown.
      }
    };

    const finish = (outcome: Effect.Effect<string, string>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(outcome);
    };

    const sendUsageCommand = () => {
      if (usageSent || settled) return;
      usageSent = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      const write = (data: string) => {
        try {
          term?.write(data);
        } catch (error) {
          finish(
            Effect.fail(
              error instanceof Error ? error.message : "Failed to send /usage to Antigravity CLI.",
            ),
          );
        }
      };
      write("/usage");
      if (settled) return;
      // ConPTY may deliver a single combined write as paste input, swallowing the Enter key.
      // @effect-diagnostics-next-line globalTimers:off
      submitTimer = setTimeout(() => write("\r"), COMMAND_INPUT_SETTLE_MS);
    };

    try {
      term = input.ptyModule.spawn(input.binaryPath, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: input.environment,
      });
    } catch (error) {
      finish(
        Effect.fail(error instanceof Error ? error.message : "Could not start Antigravity CLI."),
      );
      return;
    }

    // @effect-diagnostics-next-line globalTimersInEffect:off
    fallbackTimer = setTimeout(() => {
      sendUsageCommand();
    }, PROMPT_FALLBACK_SEND_MS);

    term.onData((chunk) => {
      if (settled) return;
      raw += chunk;
      const cleaned = stripAntigravityCliAnsi(raw);

      if (isAntigravityCliSignedOutOutput(cleaned)) {
        finish(Effect.succeed(raw));
        return;
      }

      if (!usageSent && isCliPromptReady(cleaned)) {
        sendUsageCommand();
        return;
      }

      if (usageSent && hasCompleteUsageOutput(cleaned)) {
        if (settleTimer) clearTimeout(settleTimer);
        // @effect-diagnostics-next-line globalTimers:off
        settleTimer = setTimeout(() => {
          finish(Effect.succeed(raw));
        }, OUTPUT_SETTLE_MS);
      }
    });

    term.onExit(() => {
      if (!settled) {
        finish(Effect.succeed(raw));
      }
    });

    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        cleanup();
      }
    });
  });
}

export function runAntigravityCliUsagePty(input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly ptyLoader?: () => NodePtyModule;
}): Effect.Effect<ServerProviderUsageLimits> {
  return Effect.gen(function* () {
    const requestedAtMs = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs));
    const timeoutMs = input.timeoutMs ?? DEFAULT_PTY_TIMEOUT_MS;

    const ptyModuleOption = yield* Effect.try({
      try: () => (input.ptyLoader ?? loadNodePty)(),
      catch: () => "node-pty is unavailable for Antigravity CLI /usage.",
    }).pipe(Effect.option);
    if (Option.isNone(ptyModuleOption)) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "node-pty is unavailable for Antigravity CLI /usage.",
      });
    }

    const captured = yield* captureAntigravityCliUsageRaw({
      ptyModule: ptyModuleOption.value,
      binaryPath: input.binaryPath,
      environment: input.environment,
    }).pipe(Effect.timeoutOption(timeoutMs), Effect.result);

    const completedAtMs = yield* Clock.currentTimeMillis;
    const completedAt = DateTime.formatIso(DateTime.makeUnsafe(completedAtMs));

    if (captured._tag === "Failure") {
      return makeUnavailableUsageLimits({
        checkedAt: completedAt,
        reason: "probeFailed",
        message: captured.failure,
      });
    }
    if (Option.isNone(captured.success)) {
      return makeUnavailableUsageLimits({
        checkedAt: completedAt,
        reason: "probeFailed",
        message: "Timed out waiting for Antigravity CLI /usage output.",
      });
    }

    return parseAntigravityCliUsageOutput(captured.success.value, completedAtMs);
  });
}

/**
 * Probes Antigravity account limits compliantly by invoking the official `agy` CLI
 * `/usage` command in a PTY, without reading OAuth tokens or calling internal APIs.
 */
export function probeAntigravityCliUsageLimits(
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  ServerProviderUsageLimits,
  never,
  AntigravityInstallation.AntigravityInstallation
> {
  return Effect.gen(function* () {
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const requestedAtMs = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs));
    const executable = yield* installation
      .resolve(settings.binaryPath, environment)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!executable) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity CLI binary was not found.",
      });
    }
    return yield* runAntigravityCliUsagePty({
      binaryPath: executable.executablePath,
      environment,
    });
  });
}
