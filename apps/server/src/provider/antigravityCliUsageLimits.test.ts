import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  parseAntigravityCliUsageOutput,
  runAntigravityCliUsagePty,
  stripAntigravityCliAnsi,
} from "./antigravityCliUsageLimits.ts";

const SAMPLE_USAGE_TUI = `
\x1b[1mGEMINI MODELS\x1b[0m
Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash

Weekly Limit Remaining
[\x1b[33m████████████████\x1b[90m░░░░░░░░░░░░░░░░░░░░\x1b[0m] 31.53%
\x1b[33mRefreshes in 139h 1m\x1b[0m

Five Hour Limit Remaining
[\x1b[32m█████████████████████████████████\x1b[90m░░░\x1b[0m] 94.45%
\x1b[32mRefreshes in 4h 27m\x1b[0m

\x1b[1mCLAUDE AND GPT MODELS\x1b[0m
Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B

Weekly Limit Remaining
[\x1b[32m████████████████████████████████████\x1b[0m] 100.00%
\x1b[32mQuota available\x1b[0m

Five Hour Limit Remaining
[\x1b[32m████████████████████████████████████\x1b[0m] 100.00%
\x1b[32mQuota available\x1b[0m
? for shortcuts        ● 0 运行中    上下文  0%  | 空闲
`;

describe("antigravityCliUsageLimits", () => {
  it("strips ANSI escape sequences cleanly", () => {
    const cleaned = stripAntigravityCliAnsi("\x1b[32m94.45%\x1b[0m\r\n");
    expect(cleaned).toBe("94.45%\n");
  });

  it("parses Gemini and Claude/GPT windows from agy /usage TUI output", () => {
    const now = Date.parse("2026-11-25T07:17:49.000Z");
    const result = parseAntigravityCliUsageOutput(SAMPLE_USAGE_TUI, now);

    expect(result.unavailable).toBeUndefined();
    expect(result.checkedAt).toBe("2026-11-25T07:17:49.000Z");
    expect(result.windows).toEqual([
      {
        id: "claude-gpt-5h",
        kind: "session",
        label: "Claude / GPT 5h",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini 5h",
        usedPercent: 5.55,
        resetsAt: "2026-11-25T11:44:49.000Z",
        windowDurationMins: 300,
      },
      {
        id: "claude-gpt-weekly",
        kind: "weekly",
        label: "Claude / GPT Weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini Weekly",
        usedPercent: 68.47,
        resetsAt: "2026-12-01T02:18:49.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("submits /usage through a separate Enter write and tears down the PTY", async () => {
    let onData: (chunk: string) => void = () => {};
    const writes: string[] = [];
    let killed = false;
    const result = await Effect.runPromise(
      runAntigravityCliUsagePty({
        binaryPath: "agy",
        environment: {},
        timeoutMs: 2_000,
        ptyLoader: () =>
          ({
            spawn: () => ({
              onData: (listener: typeof onData) => {
                onData = listener;
                queueMicrotask(() => listener("? for shortcuts"));
              },
              onExit: () => {},
              write: (text: string) => {
                writes.push(text);
                if (text === "\r") onData(SAMPLE_USAGE_TUI);
              },
              kill: () => {
                killed = true;
              },
            }),
          }) as unknown as typeof import("node-pty"),
      }),
    );

    expect(writes).toEqual(["/usage", "\r", "\x1b"]);
    expect(result.windows).toHaveLength(4);
    expect(killed).toBe(true);
  });

  it("reports a sign-in hint when the CLI is not signed in", () => {
    const now = Date.parse("2026-11-25T07:17:49.000Z");
    const result = parseAntigravityCliUsageOutput(
      "Welcome to the Antigravity CLI. You are currently not signed in.\nSelect login method:",
      now,
    );

    expect(result.windows).toEqual([]);
    expect(result.unavailable).toEqual({
      reason: "probeFailed",
      message: "Antigravity CLI is not signed in. Run `agy` in a terminal to sign in.",
    });
  });
});
