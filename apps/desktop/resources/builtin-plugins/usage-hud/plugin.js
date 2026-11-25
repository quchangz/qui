(() => {
  "use strict";

  const PLUGIN_ID = "usage-hud";

  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
    return String(Math.round(num));
  }

  function formatCost(usd) {
    const v = Number(usd) || 0;
    if (v === 0) return "$0.00";
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
    const v = Number(ms);
    if (v < 1000) return `${Math.round(v)}ms`;
    if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
    const mins = Math.floor(v / 60000);
    const secs = Math.round((v % 60000) / 1000);
    return `${mins}m${secs}s`;
  }

  function formatResetCountdown(isoStr, nowMs = Date.now()) {
    if (!isoStr) return "";
    const target = Date.parse(isoStr);
    if (!Number.isFinite(target)) return "";
    const diff = target - nowMs;
    if (diff <= 0) return "即将重置";
    const totalMins = Math.floor(diff / 60000);
    if (totalMins < 1) return "即将重置";
    if (totalMins < 60) return `${totalMins}m 后`;
    const hours = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    if (hours < 24) {
      return remMins > 0 ? `${hours}h ${remMins}m 后` : `${hours}h 后`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h 后` : `${days}d 后`;
  }

  function formatResetClock(isoStr, nowMs = Date.now()) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    if (!Number.isFinite(d.getTime())) return "";
    const now = new Date(nowMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `${hh}:${mi}`;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${mi}`;
  }

  function classifyQuotaColor(remainingPercent) {
    const r = Number(remainingPercent);
    if (!Number.isFinite(r) || r >= 66) return "#3F8F4F";
    if (r >= 33) return "#C98A2E";
    return "#C8544E";
  }

  function classifySpeedColor(tokPerSec) {
    if (tokPerSec === null || tokPerSec === undefined || tokPerSec === "") return "";
    const v = Number(tokPerSec);
    if (!Number.isFinite(v)) return "";
    if (v >= 60) return "#3F8F4F";
    if (v >= 25) return "#C98A2E";
    return "#C8544E";
  }

  function classifyLatencyColor(ms) {
    if (ms === null || ms === undefined || ms === "") return "";
    const v = Number(ms);
    if (!Number.isFinite(v)) return "";
    if (v < 10000) return "#3F8F4F";
    if (v <= 30000) return "#C98A2E";
    return "#C8544E";
  }

  function getQuotaSortMeta(item) {
    const pid = String(item?.providerId || "").toLowerCase();
    const id = String(item?.id || "").toLowerCase();
    const bucket = item?.bucket;
    if (pid === "codex" && (id === "primary" || bucket === "5h")) {
      return { sortOrder: 1, displayLabel: "Codex", windowTag: "5h", group: "codex", sublabel: "" };
    }
    if (pid === "codex" && (id === "secondary" || bucket === "weekly")) {
      return { sortOrder: 2, displayLabel: "Codex", windowTag: "Weekly", group: "codex", sublabel: "" };
    }
    if (pid === "antigravity" && id.includes("gemini") && bucket === "5h") {
      return { sortOrder: 3, displayLabel: "Gemini", windowTag: "5h", group: "gemini", sublabel: "" };
    }
    if (pid === "antigravity" && id.includes("gemini") && bucket === "weekly") {
      return { sortOrder: 4, displayLabel: "Gemini", windowTag: "Weekly", group: "gemini", sublabel: "" };
    }
    if (pid === "antigravity" && (id.includes("3p") || id.includes("claude") || id.includes("gpt")) && bucket === "5h") {
      return { sortOrder: 5, displayLabel: "Claude & GPT", windowTag: "5h", group: "3p", sublabel: "" };
    }
    if (pid === "antigravity" && (id.includes("3p") || id.includes("claude") || id.includes("gpt")) && bucket === "weekly") {
      return { sortOrder: 6, displayLabel: "Claude & GPT", windowTag: "Weekly", group: "3p", sublabel: "" };
    }
    const pname = item?.providerName || item?.providerId || "其他";
    const rawLbl = String(item?.label || "").replace(/\s*·\s*(5-hour|Weekly)/i, "").trim();
    return {
      sortOrder: Number(item?.sortOrder) || 99,
      displayLabel: item?.displayLabel || rawLbl || pname,
      windowTag: item?.windowTag || (bucket === "5h" ? "5h" : "Weekly"),
      group: item?.group || pid || "other",
      sublabel: item?.sublabel || "",
    };
  }

  function getOrderedQuotas(quotas) {
    if (!quotas || typeof quotas !== "object") return [];
    const raw = Array.isArray(quotas.ordered)
      ? quotas.ordered
      : [...(Array.isArray(quotas.session5h) ? quotas.session5h : []), ...(Array.isArray(quotas.weekly) ? quotas.weekly : [])];
    return raw
      .map((item, idx) => {
        const meta = getQuotaSortMeta(item);
        return {
          ...item,
          sortOrder: Number(item?.sortOrder) || meta.sortOrder,
          displayLabel: item?.displayLabel || meta.displayLabel,
          windowTag: item?.windowTag || meta.windowTag,
          group: item?.group || meta.group,
          sublabel: item?.sublabel !== undefined ? item.sublabel : meta.sublabel,
          _idx: idx,
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a._idx - b._idx);
  }

  function estimateTokensFromText(text) {
    if (!text) return 0;
    let cjk = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    }
    const other = text.length - cjk;
    return Math.round(cjk * 1.3 + other / 3.8);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function computeNiceYAxis(rawMax) {
    const m = Number(rawMax) || 0;
    if (m <= 0) {
      return { niceMax: 1, ticks: [1, 0.5, 0], isEmpty: true };
    }
    const targetStep = m / 3;
    const exp = Math.pow(10, Math.floor(Math.log10(targetStep)));
    const mults = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    let step = exp;
    for (const k of mults) {
      if (k * exp >= targetStep * 0.9999) {
        step = k * exp;
        break;
      }
    }
    const niceMax = step * 3;
    return {
      niceMax,
      ticks: [niceMax, step * 2, step, 0],
      isEmpty: false,
    };
  }

  function buildLineChartSvg(series) {
    if (!Array.isArray(series) || series.length === 0) {
      return '<div style="font-size:12px;color:var(--muted-foreground,#999);padding:18px 0;text-align:center;">暂无消耗趋势数据</div>';
    }
    const w = 600;
    const h = 156;
    const padTop = 10;
    const padBottom = 10;
    const plotH = h - padTop - padBottom;
    const rawMax = Math.max(0, ...series.map((s) => Number(s.totalTokens) || 0));
    const yAxis = computeNiceYAxis(rawMax);
    const maxVal = yAxis.niceMax;

    const pts = series.map((s, idx) => {
      const ratioX = series.length === 1 ? 0.5 : idx / (series.length - 1);
      const xSvg = Number((ratioX * w).toFixed(2));
      const xPct = Number((ratioX * 100).toFixed(3));
      const val = Number(s.totalTokens) || 0;
      const ratioY = Math.min(1, Math.max(0, val / maxVal));
      const yPx = Number((padTop + plotH * (1 - ratioY)).toFixed(2));
      return {
        idx,
        xSvg,
        xPct,
        yPx,
        label: s.label || "",
        fullLabel: s.fullLabel || s.label || "",
        val,
        input: Number(s.inputTokens) || 0,
        cachedInput: Number(s.cachedInputTokens) || 0,
        output: Number(s.outputTokens) || 0,
        cost: Number(s.costUsd) || 0,
        events: Number(s.events) || 0,
      };
    });

    const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.xSvg},${p.yPx}`).join(" ");
    const areaPath =
      pts.length > 0
        ? `${linePath} L${pts[pts.length - 1].xSvg},${padTop + plotH} L${pts[0].xSvg},${padTop + plotH} Z`
        : "";

    const gridRatios = yAxis.isEmpty ? [0, 0.5, 1] : [0, 1 / 3, 2 / 3, 1];
    const gridLines = gridRatios
      .map((ratio) => {
        const y = Number((padTop + plotH * (1 - ratio)).toFixed(2));
        return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-dasharray="3,3" />`;
      })
      .join("");

    const yTickHtml = yAxis.ticks
      .map((tick, idx) => {
        const isBottom = idx === yAxis.ticks.length - 1;
        const txt = yAxis.isEmpty ? (isBottom ? "0" : "") : tick === 0 ? "0" : formatTokens(tick);
        return `<span>${escapeHtml(txt)}</span>`;
      })
      .join("");

    const dotsHtml = pts
      .map(
        (p) =>
          `<div class="t3p-chart-dot" data-dot-idx="${p.idx}" style="left:${p.xPct}%;top:${p.yPx}px;"></div>`
      )
      .join("");

    const hitsHtml = pts
      .map(
        (p) =>
          `<div class="t3p-chart-hit" data-idx="${p.idx}" data-label="${escapeHtml(
            p.fullLabel
          )}" data-tokens="${p.val}" data-input="${p.input}" data-cached="${p.cachedInput}" data-output="${
            p.output
          }" data-cost="${p.cost}" data-events="${p.events}" data-xpct="${p.xPct}" data-ypx="${p.yPx}"></div>`
      )
      .join("");

    let xTickIndices;
    if (pts.length <= 5) {
      xTickIndices = pts.map((_, i) => i);
    } else {
      xTickIndices = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(r * (pts.length - 1)));
    }
    const xTicksHtml = xTickIndices
      .map((idx) => `<span>${escapeHtml(pts[idx]?.label || "")}</span>`)
      .join("");

    return `
      <div class="t3p-chart-box" data-t3p-line-chart="1">
        <div class="t3p-chart-main">
          <div class="t3p-chart-yaxis">${yTickHtml}</div>
          <div class="t3p-chart-plot" data-t3p-chart-plot="1">
            <svg class="t3p-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
              <defs>
                <linearGradient id="t3pLineGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--chart-1, #3b82f6)" stop-opacity="0.34" />
                  <stop offset="100%" stop-color="var(--chart-1, #3b82f6)" stop-opacity="0.02" />
                </linearGradient>
              </defs>
              ${gridLines}
              <path d="${areaPath}" fill="url(#t3pLineGrad)" />
              <path d="${linePath}" fill="none" stroke="var(--chart-1, #3b82f6)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
            </svg>
            ${dotsHtml}
            <div class="t3p-chart-crosshair" hidden></div>
            <div class="t3p-chart-active-dot" hidden></div>
            <div class="t3p-chart-hits">${hitsHtml}</div>
            <div class="t3p-chart-tooltip" hidden></div>
          </div>
        </div>
        <div class="t3p-chart-labels">
          ${xTicksHtml}
        </div>
      </div>
    `;
  }

  function buildHeatmapHtml(heatmap) {
    if (!heatmap || !Array.isArray(heatmap.cells) || heatmap.cells.length === 0) {
      return '<div style="font-size:12px;color:var(--muted-foreground,#999);padding:18px 0;text-align:center;">暂无热力图数据</div>';
    }
    const cols = Number(heatmap.cols) || 7;
    const hasRowLabels = Array.isArray(heatmap.rowLabels) && heatmap.rowLabels.length > 0;
    const gridTemplate = hasRowLabels ? `42px repeat(${cols}, minmax(0, 1fr))` : `repeat(${cols}, minmax(0, 1fr))`;

    let html = `<div class="t3p-heatmap-box" data-t3p-heatmap="1">`;
    html += `<div class="t3p-heatmap-grid" style="grid-template-columns:${gridTemplate};">`;
    if (Array.isArray(heatmap.colLabels) && heatmap.colLabels.length > 0) {
      if (hasRowLabels) html += `<div></div>`;
      for (const cl of heatmap.colLabels) {
        html += `<div class="t3p-hm-col-hd">${escapeHtml(cl)}</div>`;
      }
    }

    for (let i = 0; i < heatmap.cells.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (hasRowLabels && col === 0) {
        html += `<div class="t3p-hm-row-hd">${escapeHtml(heatmap.rowLabels[row] || "")}</div>`;
      }
      const cell = heatmap.cells[i];
      if (cell.placeholder) {
        html += `<div class="t3p-hm-cell" data-level="-1"></div>`;
      } else {
        const tagHtml = cell.shortTag ? `<span class="t3p-hm-tag">${escapeHtml(cell.shortTag)}</span>` : "";
        html += `<div class="t3p-hm-cell" data-level="${cell.level}" data-hm-label="${escapeHtml(
          cell.label || ""
        )}" data-hm-tokens="${Number(cell.totalTokens) || 0}" data-hm-input="${
          Number(cell.inputTokens) || 0
        }" data-hm-output="${Number(cell.outputTokens) || 0}" data-hm-cost="${
          Number(cell.costUsd) || 0
        }" data-hm-events="${Number(cell.events) || 0}">${tagHtml}</div>`;
      }
    }
    html += `</div>`;
    html += `<div class="t3p-chart-tooltip" hidden></div>`;
    html += `</div>`;
    html += `
      <div class="t3p-hm-legend">
        <span>悬停单元格查看精确 Token 与费用</span>
        <span class="t3p-hm-swatches">
          <span>少</span>
          <span class="t3p-hm-cell" data-level="0" style="width:11px;height:11px;"></span>
          <span class="t3p-hm-cell" data-level="1" style="width:11px;height:11px;"></span>
          <span class="t3p-hm-cell" data-level="2" style="width:11px;height:11px;"></span>
          <span class="t3p-hm-cell" data-level="3" style="width:11px;height:11px;"></span>
          <span class="t3p-hm-cell" data-level="4" style="width:11px;height:11px;"></span>
          <span>多</span>
        </span>
      </div>
    `;
    return html;
  }

  function computeScreenCenteredChatInsets({
    viewportWidth,
    canvasLeft,
    canvasRight,
    basePadding = 48,
    chatMaxWidth = 736,
    detailsLeft = null,
    nativeInsetEnd = 0,
    isFullWidth = false,
  }) {
    const vpW = Number(viewportWidth) || 0;
    const cLeft = Number(canvasLeft) || 0;
    const cRight = Number(canvasRight) || 0;
    const pad = Math.max(0, Number(basePadding) || 0);
    const maxW = Math.max(0, Number(chatMaxWidth) || 0);
    const natEnd = Math.max(0, Number(nativeInsetEnd) || 0);

    if (isFullWidth || vpW <= 0 || cRight - cLeft <= pad * 2 || maxW <= 0) {
      return { active: false, insetStart: 0, insetEnd: 0 };
    }

    const leftLimit = cLeft + pad;
    const rawDetailsLeft =
      detailsLeft !== null && detailsLeft !== undefined && Number.isFinite(Number(detailsLeft))
        ? Number(detailsLeft)
        : null;
    const rightLimit =
      rawDetailsLeft !== null && rawDetailsLeft > leftLimit + 200
        ? Math.min(cRight - pad, rawDetailsLeft - 24)
        : cRight - pad;

    const available = Math.max(0, rightLimit - leftLimit);
    if (available <= 0) {
      return { active: false, insetStart: 0, insetEnd: 0 };
    }

    const chatWidth = Math.min(maxW, available);
    const hasSplitRight = vpW - cRight > 40;
    const idealLeft = hasSplitRight
      ? leftLimit + (available - chatWidth) / 2
      : (vpW - chatWidth) / 2;

    const minLeft = leftLimit;
    const maxLeft = Math.max(minLeft, rightLimit - chatWidth);
    const clampedLeft = Math.max(minLeft, Math.min(idealLeft, maxLeft));

    const leftMargin = Math.max(0, clampedLeft - (cLeft + pad));
    const rightMargin = Math.max(0, cRight - pad - (clampedLeft + chatWidth));

    if (rightMargin >= leftMargin) {
      return {
        active: true,
        insetStart: 0,
        insetEnd: Math.max(Math.round(rightMargin - leftMargin), Math.round(natEnd)),
      };
    }
    return {
      active: true,
      insetStart: Math.round(leftMargin - rightMargin),
      insetEnd: Math.max(0, Math.round(natEnd)),
    };
  }

  function formatRangeBadge(range) {
    if (range === "7d") return "近 7 天";
    if (range === "30d") return "近 30 天";
    return "今日";
  }

  const STREAM_IGNORED_KINDS = new Set([
    "working",
    "attempt-fold",
    "turn-fold",
    "event",
    "worktree-setup",
    "sent-message",
  ]);

  function detectFirstStreamingDelta(rows, baselineState) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { detected: false, rowId: null, textLen: 0, isNewRow: false };
    }
    const baseIds = baselineState?.rowIds instanceof Set ? baselineState.rowIds : new Set();
    for (const row of rows) {
      if (!row || !row.rowId) continue;
      if (row.role !== "assistant" || STREAM_IGNORED_KINDS.has(row.kind)) continue;
      const len = Number(row.textLen) || 0;
      if (!baseIds.has(row.rowId) && len > 0) {
        return { detected: true, rowId: row.rowId, textLen: len, isNewRow: true };
      }
    }
    const baseLastId = baselineState?.lastAssistantRowId || null;
    const baseLastLen = Number(baselineState?.lastAssistantLen) || 0;
    if (baseLastId) {
      for (const row of rows) {
        if (!row || row.rowId !== baseLastId) continue;
        const len = Number(row.textLen) || 0;
        if (len > baseLastLen) {
          return { detected: true, rowId: row.rowId, textLen: len, isNewRow: false };
        }
      }
    }
    return { detected: false, rowId: null, textLen: 0, isNewRow: false };
  }

  const Core = {
    formatTokens,
    formatCost,
    formatDuration,
    formatRangeBadge,
    formatResetCountdown,
    formatResetClock,
    classifyQuotaColor,
    classifySpeedColor,
    classifyLatencyColor,
    getOrderedQuotas,
    estimateTokensFromText,
    detectFirstStreamingDelta,
    computeNiceYAxis,
    buildLineChartSvg,
    buildHeatmapHtml,
    computeScreenCenteredChatInsets,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Core;
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  window.__T3UsageHudCore = Core;
  if (window.__T3_USAGE_HUD_MOUNTED__) return;
  window.__T3_USAGE_HUD_MOUNTED__ = true;

  if (window.T3Plugins && typeof window.T3Plugins.register === "function") {
    window.T3Plugins.register({
      id: PLUGIN_ID,
      name: "用量与会话详情增强",
      version: "1.0.0",
    });
  }

  const DEFAULT_PREFS = {
    quotaTab: "5h",
    chartType: "line",
    range: "1d",
    detailTab: "providers",
  };

  let prefs = { ...DEFAULT_PREFS };
  let overviewData = null;
  let activeThreadId = null;
  let hudRoot = null;
  let modalBackdrop = null;
  let modalOpen = false;
  let rafScheduled = false;
  let isFetching = false;
  let fetchSeq = 0;
  let lastFetchMs = 0;

  // Live streaming speed & TTFT state
  const live = {
    active: false,
    threadId: null,
    baselineRowIds: new Set(),
    baselineLastAssistantRowId: null,
    baselineLastAssistantLen: 0,
    previousRunId: null,
    streamRowId: null,
    streamBaselineLen: 0,
    streamLastLen: 0,
    textObserved: false,
    lastChangeMs: 0,
    samples: [], // { ts, tokens }
    liveTokPerSec: null,
  };

  async function savePrefs(next) {
    prefs = { ...prefs, ...next };
    if (window.T3Plugins && typeof window.T3Plugins.saveState === "function") {
      await window.T3Plugins.saveState(PLUGIN_ID, prefs);
    }
  }

  function detectActiveThreadId(cardEl) {
    const focusHost = cardEl?.closest?.('[data-workspace-focus-key^="details:"]');
    if (focusHost) {
      const fk = focusHost.getAttribute("data-workspace-focus-key") || "";
      const parts = fk.split(":");
      if (parts.length >= 3) {
        return parts.slice(2).join(":");
      }
    }
    const urlMatch = window.location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (urlMatch) return urlMatch[0];
    const currentRow = document.querySelector('[data-thread-item][aria-current="page"], [data-sidebar-row][aria-current="page"]');
    const rowAttr = currentRow?.getAttribute("data-sidebar-row") || "";
    if (rowAttr) {
      const m = rowAttr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) return m[0];
    }
    return null;
  }

  function findVisibleDetailsCard() {
    const cards = Array.from(document.querySelectorAll("[data-thread-details-card]"));
    if (cards.length === 0) return null;
    for (const el of cards) {
      try {
        if (el.offsetParent !== null) return el;
        if (typeof el.getBoundingClientRect === "function" && el.getBoundingClientRect().height > 0) {
          return el;
        }
      } catch {
        // ignore layout query failures
      }
    }
    return cards[0];
  }

  function suppressNativeUsageSections(cardEl) {
    const markSection = (sec) => {
      if (!sec || sec === cardEl) return;
      if (hudRoot && (sec === hudRoot || sec.contains(hudRoot))) return;
      if (sec.closest("[data-t3p-usage-hud]")) return;
      if (sec.getAttribute("data-t3p-replaced-native") !== "1") {
        sec.setAttribute("data-t3p-replaced-native", "1");
      }
    };

    const headings = cardEl.querySelectorAll("#thread-details-usage-heading, #thread-details-context-heading");
    for (const h of headings) {
      markSection(h.closest("section"));
    }

    const sections = cardEl.querySelectorAll("section[aria-label]");
    for (const sec of sections) {
      const label = (sec.getAttribute("aria-label") || "").trim();
      if (/^(Usage limits|用量限制|Context window|上下文窗口)$/i.test(label)) {
        markSection(sec);
      }
    }
  }

  function findHudMountTarget(cardEl) {
    // T3 ThreadDetailsCard structure:
    // [data-thread-details-card] -> ScrollArea.Root -> [data-slot="scroll-area-viewport"] -> div(ref=P) -> div.group/details-items
    const itemsEl = cardEl.querySelector(".group\\/details-items");
    if (itemsEl && itemsEl.parentElement && cardEl.contains(itemsEl.parentElement)) {
      return itemsEl.parentElement;
    }
    const viewportDiv = cardEl.querySelector('[data-slot="scroll-area-viewport"] > div');
    if (viewportDiv) return viewportDiv;
    const viewport = cardEl.querySelector('[data-slot="scroll-area-viewport"]');
    return viewport || cardEl;
  }

  async function fetchOverview(force = false) {
    if (isFetching && !force) return;
    isFetching = true;
    const seq = ++fetchSeq;
    try {
      const params = new URLSearchParams({ range: prefs.range || "1d" });
      if (activeThreadId) params.set("threadId", activeThreadId);
      const apiPath = `/__t3_plugins__/api/${PLUGIN_ID}/overview?${params.toString()}&t=${Date.now()}`;
      const url =
        window.T3Plugins && typeof window.T3Plugins.apiUrl === "function"
          ? window.T3Plugins.apiUrl(apiPath)
          : apiPath;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nextData = await res.json();
      if (seq !== fetchSeq) return;

      overviewData = nextData;
      lastFetchMs = Date.now();

      renderHud();
    } catch (err) {
      if (seq === fetchSeq) {
        console.warn("[usage-hud] fetchOverview failed:", err);
      }
    } finally {
      if (seq === fetchSeq) {
        isFetching = false;
        if (modalOpen) renderModal();
      }
    }
  }

  const ICONS = {
    quota: '<svg class="t3p-uhud-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 11.5a6.5 6.5 0 1 1 11 0"/><path d="M8 8l3-3"/><circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg>',
    layers: '<svg class="t3p-uhud-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 14 5.2 8 8.4 2 5.2 8 2Z"/><path d="M2 8.2 8 11.4 14 8.2"/><path d="M2 11.2 8 14.4 14 11.2"/></svg>',
    speed: '<svg class="t3p-uhud-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 1.8 3.6 9.2h4.2l-1 5 5.6-7.4H8.2l1-5Z"/></svg>',
    chart: '<svg class="t3p-uhud-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5h11"/><path d="M4.5 11V7.5"/><path d="M8 11V4.5"/><path d="M11.5 11V6"/></svg>',
  };

  function renderQuotaRows(list, unavailable = []) {
    const statusHtml = unavailable.map(({ providerName, message, lastGood }) => {
      const expired = /sign-in has expired/i.test(message);
      const label = expired
        ? "Google 额度暂不可用 · 查询凭据需续期"
        : "Google 额度暂不可用";
      const previous = lastGood?.windows?.map(({ displayLabel, windowTag, remainingPercent }) =>
        `${displayLabel} ${windowTag} ${remainingPercent}%`).join(" · ");
      return `<div class="t3p-uhud-empty" title="${escapeHtml(providerName + " · " + message)}">
        <div>${label}</div>
        ${expired ? "<div>发起一轮 Antigravity 对话后刷新额度</div>" : ""}
        ${previous ? `<div>历史快照 ${escapeHtml(formatResetClock(lastGood.checkedAt))} · ${escapeHtml(previous)}</div>` : ""}
      </div>`;
    }).join("");
    if (!Array.isArray(list) || list.length === 0) {
      return statusHtml || '<div class="t3p-uhud-empty">当前暂无可用订阅额度记录</div>';
    }
    const now = Date.now();
    const isPastReset = (item) => item.resetsAt && Date.parse(item.resetsAt) <= now;
    const byId = new Map(list.map((item) => [`${item.providerId}:${item.id}`, item]));
    let prevGroup = null;
    return list
      .map((item, idx) => {
        const rem = item.remainingPercent;
        const awaitingQuota = isPastReset(item);
        const color = awaitingQuota ? "var(--muted-foreground, #888)" : classifyQuotaColor(rem);
        const resetTxt = awaitingQuota ? "待刷新" : formatResetCountdown(item.resetsAt, now);
        const resetClock = formatResetClock(item.resetsAt);
        const meta = getQuotaSortMeta(item);
        const titleText = item.displayLabel || meta.displayLabel;
        const winTag = item.windowTag || meta.windowTag || (item.bucket === "5h" ? "5h" : "Weekly");
        const bucketAttr = item.bucket === "5h" || /^5h$/i.test(winTag) ? "5h" : "weekly";
        const group = item.group || meta.group;
        const groupBreak = idx > 0 && group !== prevGroup;
        prevGroup = group;
        const siblingId = item.providerId === "antigravity" && /^gemini(?:-[a-z0-9]+)*-(?:5h|weekly)$/i.test(item.id)
          ? item.id.replace(/-(?:5h|weekly)$/i, item.bucket === "5h" ? "-weekly" : "-5h")
          : null;
        const sibling = siblingId ? byId.get(`${item.providerId}:${siblingId}`) : null;
        const blockedBySibling = !awaitingQuota && !item.exhausted && sibling?.exhausted && !isPastReset(sibling);
        const blockedText = blockedBySibling ? `${sibling.bucket === "5h" ? "5 小时" : "周"}额度已用尽` : "";
        const checkedClock = formatResetClock(item.checkedAt, now);
        const tip = [item.providerName, item.label, checkedClock && `快照 ${checkedClock}`, blockedText].filter(Boolean).join(" · ");
        const remainingText = awaitingQuota ? "—" : rem === 0 && item.exhausted === false ? "<0.1%" : `${rem}%`;
        return `
          <div class="t3p-uhud-qrow" data-group-break="${groupBreak ? "true" : "false"}">
            <div class="t3p-uhud-qmeta">
              <span class="t3p-uhud-qname" title="${escapeHtml(tip)}"><span>${escapeHtml(titleText)}</span><span class="t3p-qtag" data-bucket="${bucketAttr}">${escapeHtml(winTag)}</span></span>
              <span class="t3p-uhud-qval">${
                resetTxt
                  ? `<span class="t3p-uhud-qpill" title="${escapeHtml(resetClock ? `${resetClock} 重置` : "")}">${escapeHtml(resetTxt)}</span>`
                  : ""
              }<strong class="t3p-uhud-qpct" style="color:${color};">${escapeHtml(remainingText)}</strong></span>
            </div>
            <div class="t3p-uhud-bar">
              <div class="t3p-uhud-bar-fill" style="width:${awaitingQuota ? 0 : rem}%;background:${color};"></div>
            </div>
            ${blockedText ? `<div class="t3p-uhud-ctx-summary">当前受限 · ${escapeHtml(blockedText)}</div>` : ""}
          </div>
        `;
      })
      .join("") + statusHtml;
  }

  function renderContextBreakdown(ctx) {
    if (!ctx) {
      return `
        <div class="t3p-uhud-sec">
          <div class="t3p-uhud-sec-hd">
            <span class="t3p-uhud-sec-title">${ICONS.layers}<span>上下文窗口</span></span>
            <span class="t3p-uhud-ctx-summary">暂无上下文记录</span>
          </div>
          <div class="t3p-ctx-segbar"></div>
        </div>
      `;
    }

    const maxTok = Number(ctx.maxTokens) || 0;
    const winUsed = Number(ctx.windowUsedTokens ?? ctx.usedTokens) || 0;
    const pctVal =
      ctx.windowUsedPercent != null
        ? Number(ctx.windowUsedPercent)
        : ctx.usedPercent != null
          ? Number(ctx.usedPercent)
          : maxTok > 0
            ? Number(Math.min(100, (winUsed / maxTok) * 100).toFixed(1))
            : null;
    const prefix = ctx.windowEstimated ? "~" : "";
    const summaryText =
      maxTok > 0
        ? `${prefix}${formatTokens(winUsed)} / ${formatTokens(maxTok)}${pctVal !== null ? ` (${pctVal}%)` : ""}`
        : `${prefix}${formatTokens(winUsed)} tok`;
    const summaryTitle = ctx.windowEstimated
      ? "基于当前会话最近压缩点起的活跃内容估算；下方「输入 / 输出 / 思考」为会话累计精确/记录值"
      : "精确上下文窗口占用";

    const items = Array.isArray(ctx.breakdown) ? ctx.breakdown.filter((x) => Number(x?.tokens) > 0) : [];
    const totalShown = items.reduce((acc, x) => acc + (Number(x.tokens) || 0), 0);
    const denom = maxTok > 0 ? Math.max(maxTok, totalShown || winUsed) : Math.max(1, totalShown || winUsed);

    const segsHtml =
      items.length > 0
        ? items
            .map((seg) => {
              const segPct = Math.max(0.4, (Number(seg.tokens) / denom) * 100);
              const share = totalShown > 0 ? ((Number(seg.tokens) / totalShown) * 100).toFixed(1) : "0";
              return `<span class="t3p-ctx-seg" style="width:${segPct.toFixed(2)}%;background:${escapeHtml(seg.color || "#3b82f6")};" title="${escapeHtml(`${seg.label}: ${formatTokens(seg.tokens)} (${share}%)`)}"></span>`;
            })
            .join("")
        : winUsed > 0 && pctVal !== null
          ? `<span class="t3p-ctx-seg" style="width:${Math.max(1, pctVal)}%;background:#2563eb;"></span>`
          : "";

    const legendItems = items.slice(0, 8);
    const legendHtml =
      legendItems.length > 0
        ? `<div class="t3p-ctx-legend">${legendItems
            .map(
              (seg) => `
                <div class="t3p-ctx-item" title="${escapeHtml(`${seg.label}: ${seg.tokens.toLocaleString()} tokens`)}">
                  <span class="t3p-ctx-left">
                    <span class="t3p-ctx-dot" style="background:${escapeHtml(seg.color || "#3b82f6")};"></span>
                    <span class="t3p-ctx-name">${escapeHtml(seg.label)}</span>
                  </span>
                  <span class="t3p-ctx-val">${formatTokens(seg.tokens)}</span>
                </div>`
            )
            .join("")}</div>`
        : '<div class="t3p-uhud-empty">暂无上下文构成明细</div>';

    const hitRate = Number(ctx.cacheHitRate) || 0;
    const hitRateColor = hitRate >= 60 ? "#3F8F4F" : hitRate >= 25 ? "#C98A2E" : "var(--foreground, inherit)";

    return `
      <div class="t3p-uhud-sec">
        <div class="t3p-uhud-sec-hd">
          <span class="t3p-uhud-sec-title">${ICONS.layers}<span>上下文窗口</span></span>
          <span class="t3p-uhud-ctx-summary" title="${escapeHtml(summaryTitle)}">${escapeHtml(summaryText)}</span>
        </div>
        <div class="t3p-ctx-segbar">${segsHtml}</div>
        ${legendHtml}
        <div class="t3p-tok-rows">
          <div class="t3p-tok-row">
            <div class="t3p-tok-card">
              <div class="k">输入</div>
              <div class="v">${formatTokens(ctx.inputTokens)}</div>
            </div>
            <div class="t3p-tok-card">
              <div class="k">缓存命中</div>
              <div class="v"><span style="color:${hitRateColor};">${hitRate}%</span><span class="sub">· ${formatTokens(ctx.cachedInputTokens)}</span></div>
            </div>
          </div>
          <div class="t3p-tok-row">
            <div class="t3p-tok-card">
              <div class="k">输出</div>
              <div class="v">${formatTokens(ctx.outputTokens)}</div>
            </div>
            <div class="t3p-tok-card">
              <div class="k">思考</div>
              <div class="v">${formatTokens(ctx.reasoningTokens)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderHud() {
    if (!hudRoot || !hudRoot.isConnected) return;
    if (!overviewData) {
      hudRoot.innerHTML = '<div class="t3p-uhud-empty">正在加载用量与性能数据…</div>';
      return;
    }

    const orderedQuotas = getOrderedQuotas(overviewData.quotas);
    const thread = overviewData.thread || {};
    const ctx = thread.context;
    const spd = thread.speed || {};
    const globalTotals = overviewData.global?.totals || {};

    // Speed & latency (prefer live streaming metrics when active)
    const rawSpeedVal =
      live.active && live.liveTokPerSec !== null
        ? Number(live.liveTokPerSec)
        : spd.lastTurnTokPerSec !== null && spd.lastTurnTokPerSec !== undefined
          ? Number(spd.lastTurnTokPerSec)
          : null;
    const displaySpeed =
      live.active && live.liveTokPerSec !== null
        ? `${live.liveTokPerSec.toFixed(1)}`
        : rawSpeedVal !== null
          ? `${spd.lastTurnTokPerSec}`
          : "—";
    const speedColor = classifySpeedColor(rawSpeedVal);

    const latestTurn = thread.turns?.[0];
    const rawLatencyMs = live.active && (thread.threadId !== live.threadId || latestTurn?.runId === live.previousRunId)
      ? null
      : latestTurn?.ttftMs ?? null;
    const displayLatency = live.active && rawLatencyMs === null && !live.textObserved
      ? "等待中"
      : formatDuration(rawLatencyMs);
    const latencyLabel = "首字延迟";
    const latencyColor = classifyLatencyColor(rawLatencyMs);

    const rawAvgSpeed =
      spd.avgTokPerSec !== null && spd.avgTokPerSec !== undefined ? Number(spd.avgTokPerSec) : null;
    const displayAvgSpeed = rawAvgSpeed !== null ? `${spd.avgTokPerSec}` : "—";
    const avgSpeedColor = classifySpeedColor(rawAvgSpeed);
    const ctaRangeLabel = formatRangeBadge(overviewData.global?.range || prefs.range || "1d");

    hudRoot.innerHTML = `
      <div class="t3p-uhud-hd">
        <span class="t3p-uhud-title">${ICONS.chart}<span>用量与性能</span></span>
        <span class="t3p-uhud-badge" data-live="${live.active ? "true" : "false"}">${live.active ? "● 输出测速中" : "● 实时"}</span>
      </div>

      <div class="t3p-uhud-sec">
        <div class="t3p-uhud-sec-hd">
          <span class="t3p-uhud-sec-title">${ICONS.quota}<span>订阅可用额度</span></span>
          <span class="t3p-uhud-hint">5h + 周额度</span>
        </div>
        <div class="t3p-uhud-qlist">
          ${renderQuotaRows(orderedQuotas, overviewData.quotas?.unavailable)}
        </div>
      </div>

      ${renderContextBreakdown(ctx)}

      <div class="t3p-uhud-sec">
        <div class="t3p-uhud-sec-hd">
          <span class="t3p-uhud-sec-title">${ICONS.speed}<span>速度与延迟</span></span>
          <span class="t3p-uhud-mono t3p-uhud-hint">${spd.completedTurns || 0} 轮完成</span>
        </div>
        <div class="t3p-uhud-grid3">
          <div class="t3p-uhud-stat" title="输出吞吐配色：≥60 tok/s 绿 · 25–60 黄 · <25 红"><div class="k">${live.active ? "实时 tok/s" : "输出 tok/s"}</div><div class="v"${speedColor ? ` style="color:${speedColor};"` : ""}>${escapeHtml(displaySpeed)}</div></div>
          <div class="t3p-uhud-stat" title="从提交请求到 T3 首次收到可见的助手文字，包含进度说明。整条到达时取消息到达时间。"><div class="k">${latencyLabel}</div><div class="v"${latencyColor ? ` style="color:${latencyColor};"` : ""}>${escapeHtml(displayLatency)}</div></div>
          <div class="t3p-uhud-stat" title="会话均速配色：≥60 tok/s 绿 · 25–60 黄 · <25 红"><div class="k">平均 tok/s</div><div class="v"${avgSpeedColor ? ` style="color:${avgSpeedColor};"` : ""}>${escapeHtml(displayAvgSpeed)}</div></div>
        </div>
      </div>

      <button type="button" class="t3p-uhud-cta" data-t3p-open-modal="1">
        <span>${escapeHtml(ctaRangeLabel)} ${formatTokens(globalTotals.totalTokens || 0)} tok · 估算 ${formatCost(globalTotals.costUsd || 0)}</span>
        <span>统计弹窗 ↗</span>
      </button>
    `;

    const openBtn = hudRoot.querySelector("[data-t3p-open-modal]");
    if (openBtn) {
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openUsageModal();
      });
    }
  }

  function closeUsageModal() {
    modalOpen = false;
    if (modalBackdrop) {
      modalBackdrop.remove();
      modalBackdrop = null;
    }
  }

  function renderModelCell(provider, model) {
    const prov = String(provider || "").toLowerCase();
    const m = String(model || "");
    let roleBadge = "";
    if (prov === "antigravity" && /^gemini-pro-orchestrator/i.test(m)) {
      roleBadge = '<span class="t3p-role-tag t3p-role-plan">规划</span>';
    } else if (prov === "antigravity" && /(?:-orchestrator$|worker)/i.test(m)) {
      roleBadge = '<span class="t3p-role-tag t3p-role-exec">执行</span>';
    }
    return `<span class="t3p-umodal-pill">${escapeHtml(provider)}</span>${escapeHtml(m)}${roleBadge}`;
  }

  function renderTooltipHtml(label, tokens, inputTok, outputTok, cost, events) {
    return `
      <div class="t3p-tt-hd">${escapeHtml(label)}</div>
      <div class="t3p-tt-row"><span class="t3p-tt-k">总 Token</span><span class="t3p-tt-v">${escapeHtml(formatTokens(tokens))}</span></div>
      <div class="t3p-tt-row"><span class="t3p-tt-k">输入 / 输出</span><span class="t3p-tt-v">${escapeHtml(formatTokens(inputTok))} / ${escapeHtml(formatTokens(outputTok))}</span></div>
      <div class="t3p-tt-row"><span class="t3p-tt-k">估算费用</span><span class="t3p-tt-v">${escapeHtml(formatCost(cost))}</span></div>
      <div class="t3p-tt-row"><span class="t3p-tt-k">调用事件</span><span class="t3p-tt-v">${events} 次</span></div>
    `;
  }

  function bindModalChartInteractions(modal) {
    // 1. Line chart hover crosshair + custom popover tooltip
    const plot = modal.querySelector('[data-t3p-chart-plot="1"]');
    if (plot) {
      const hits = Array.from(plot.querySelectorAll(".t3p-chart-hit"));
      const dots = Array.from(plot.querySelectorAll(".t3p-chart-dot"));
      const crosshair = plot.querySelector(".t3p-chart-crosshair");
      const activeDot = plot.querySelector(".t3p-chart-active-dot");
      const tooltip = plot.querySelector(".t3p-chart-tooltip");
      let activeIdx = -1;

      const clearLineHover = () => {
        if (activeIdx >= 0 && dots[activeIdx]) dots[activeIdx].classList.remove("is-active");
        activeIdx = -1;
        if (crosshair) crosshair.hidden = true;
        if (activeDot) activeDot.hidden = true;
        if (tooltip) tooltip.hidden = true;
      };

      const activatePoint = (idx, rect) => {
        const hit = hits[idx];
        if (!hit) return;
        if (activeIdx >= 0 && activeIdx !== idx && dots[activeIdx]) {
          dots[activeIdx].classList.remove("is-active");
        }
        activeIdx = idx;
        if (dots[idx]) dots[idx].classList.add("is-active");

        const xPct = Number(hit.getAttribute("data-xpct")) || 0;
        const yPx = Number(hit.getAttribute("data-ypx")) || 0;
        const label = hit.getAttribute("data-label") || "";
        const tokens = Number(hit.getAttribute("data-tokens")) || 0;
        const inputTok = Number(hit.getAttribute("data-input")) || 0;
        const outputTok = Number(hit.getAttribute("data-output")) || 0;
        const cost = Number(hit.getAttribute("data-cost")) || 0;
        const events = Number(hit.getAttribute("data-events")) || 0;

        if (crosshair) {
          crosshair.style.left = `${xPct}%`;
          crosshair.hidden = false;
        }
        if (activeDot) {
          activeDot.style.left = `${xPct}%`;
          activeDot.style.top = `${yPx}px`;
          activeDot.hidden = false;
        }
        if (tooltip) {
          tooltip.innerHTML = renderTooltipHtml(label, tokens, inputTok, outputTok, cost, events);
          tooltip.hidden = false;
          const plotW = rect.width || plot.clientWidth || 540;
          const plotH = rect.height || plot.clientHeight || 156;
          const ttW = tooltip.offsetWidth || 180;
          const ttH = tooltip.offsetHeight || 90;
          const dotX = (xPct / 100) * plotW;
          const left =
            xPct > 58
              ? Math.max(4, dotX - ttW - 12)
              : Math.min(Math.max(4, plotW - ttW - 4), dotX + 12);
          const top = Math.max(4, Math.min(Math.max(4, plotH - ttH - 4), yPx - ttH / 2));
          tooltip.style.left = `${Math.round(left)}px`;
          tooltip.style.top = `${Math.round(top)}px`;
        }
      };

      const onLineMove = (e) => {
        if (hits.length === 0) return;
        const rect = plot.getBoundingClientRect();
        let idx = -1;
        if (rect && rect.width > 0 && Number.isFinite(e.clientX)) {
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          idx = hits.length === 1 ? 0 : Math.round(ratio * (hits.length - 1));
        } else {
          const hitEl = e.target && e.target.closest ? e.target.closest(".t3p-chart-hit") : null;
          if (hitEl) idx = Number(hitEl.getAttribute("data-idx"));
        }
        if (idx >= 0 && idx < hits.length) {
          activatePoint(idx, rect || { width: 540, height: 156 });
        }
      };

      plot.addEventListener("mouseenter", onLineMove);
      plot.addEventListener("mousemove", onLineMove);
      plot.addEventListener("mouseleave", clearLineHover);
    }

    // 2. Heatmap hover custom popover tooltip
    const hmBox = modal.querySelector('[data-t3p-heatmap="1"]');
    if (hmBox) {
      const tooltip = hmBox.querySelector(".t3p-chart-tooltip");
      const hideHmTooltip = () => {
        if (tooltip) tooltip.hidden = true;
      };
      const showForCell = (e) => {
        const cell = e.target && e.target.closest ? e.target.closest(".t3p-hm-cell[data-hm-label]") : null;
        if (!cell || !tooltip) {
          hideHmTooltip();
          return;
        }
        const label = cell.getAttribute("data-hm-label") || "";
        const tokens = Number(cell.getAttribute("data-hm-tokens")) || 0;
        const inputTok = Number(cell.getAttribute("data-hm-input")) || 0;
        const outputTok = Number(cell.getAttribute("data-hm-output")) || 0;
        const cost = Number(cell.getAttribute("data-hm-cost")) || 0;
        const events = Number(cell.getAttribute("data-hm-events")) || 0;

        tooltip.innerHTML = renderTooltipHtml(label, tokens, inputTok, outputTok, cost, events);
        tooltip.hidden = false;

        const boxRect = hmBox.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        const boxW = boxRect.width || hmBox.clientWidth || 560;
        const ttW = tooltip.offsetWidth || 180;
        const ttH = tooltip.offsetHeight || 90;

        if (boxRect.width > 0 && cellRect.width > 0) {
          const centerX = cellRect.left - boxRect.left + cellRect.width / 2;
          const left = Math.max(0, Math.min(Math.max(0, boxW - ttW), centerX - ttW / 2));
          const aboveTop = cellRect.top - boxRect.top - ttH - 8;
          const top = aboveTop >= 0 ? aboveTop : cellRect.bottom - boxRect.top + 8;
          tooltip.style.left = `${Math.round(left)}px`;
          tooltip.style.top = `${Math.round(top)}px`;
        } else {
          tooltip.style.left = "8px";
          tooltip.style.top = "8px";
        }
      };

      hmBox.addEventListener("mouseover", showForCell);
      hmBox.addEventListener("mousemove", showForCell);
      hmBox.addEventListener("mouseleave", hideHmTooltip);
    }
  }

  function renderModal() {
    if (!modalBackdrop) return;
    const modal = modalBackdrop.querySelector(".t3p-umodal");
    if (!modal) return;

    const data = overviewData || {};
    const selectedRange = prefs.range;
    const rangeReady = data.global?.range === selectedRange;
    const g = rangeReady ? data.global : {};
    const t = g.totals || {};
    const quotas = data.quotas || { session5h: [], weekly: [], resetCredits: [] };
    const thread = data.thread || {};
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const byPm = Array.isArray(g.byProviderModel) ? g.byProviderModel : [];
    const rangeLabel = selectedRange === "1d" ? "今日分时段" : formatRangeBadge(selectedRange);
    const rangeStatus = isFetching ? "正在加载该时段…" : "该时段加载失败，请刷新";

    const chartHtml = !rangeReady
      ? `<div class="t3p-uhud-empty" role="status">${rangeStatus}</div>`
      : prefs.chartType === "heatmap" ? buildHeatmapHtml(g.heatmap) : buildLineChartSvg(g.series);

    const providerRowsHtml =
      byPm.length > 0
        ? byPm
            .slice(0, 24)
            .map((r) => {
              const spdColor = classifySpeedColor(r.avgTokPerSec);
              return `
              <tr>
                <td>${renderModelCell(r.provider, r.model)}</td>
                <td class="num">${formatTokens(r.totalTokens)}</td>
                <td class="num">${r.inputTokens > 0 ? Math.round((r.cachedInputTokens / r.inputTokens) * 100) + "%" : "—"}</td>
                <td class="num"${spdColor ? ` style="color:${spdColor};font-weight:600;"` : ""}>${r.avgTokPerSec != null ? r.avgTokPerSec + "/s" : "—"}</td>
                <td class="num">${formatCost(r.costUsd)}</td>
              </tr>`;
            })
            .join("")
        : `<tr><td colspan="5" style="text-align:center;color:var(--muted-foreground,#999);">${rangeReady ? "当前时段暂无统计记录" : rangeStatus}</td></tr>`;

    const turnRowsHtml =
      turns.length > 0
        ? turns
            .slice(0, 15)
            .map((r) => {
              const rowLatMs = r.ttftMs;
              const latColor = classifyLatencyColor(rowLatMs);
              const spdColor = classifySpeedColor(r.tokPerSec);
              return `
              <tr>
                <td class="t3p-uhud-mono">#${r.ordinal}</td>
                <td>${escapeHtml(r.model || r.provider)}</td>
                <td class="num">${formatTokens(r.outputTokens)} / ${formatTokens(r.reasoningTokens)}</td>
                <td class="num"${latColor ? ` style="color:${latColor};font-weight:600;"` : ""}>${formatDuration(rowLatMs)}</td>
                <td class="num"${spdColor ? ` style="color:${spdColor};font-weight:600;"` : ""}>${r.tokPerSec != null ? r.tokPerSec + "/s" : "—"}</td>
              </tr>`;
            })
            .join("")
        : '<tr><td colspan="5" style="text-align:center;color:var(--muted-foreground,#999);">当前会话暂无已完成轮次</td></tr>';

    const creditNote =
      Array.isArray(quotas.resetCredits) && quotas.resetCredits.length > 0
        ? quotas.resetCredits.map((c) => `${c.providerName} 可用重置券: ${c.availableCount}`).join(" · ")
        : "";
    const globalAvgSpeedColor = classifySpeedColor(t.avgTokPerSec);

    modal.innerHTML = `
      <div class="t3p-umodal-hd">
        <div class="t3p-umodal-title">用量与 Token 统计看板</div>
        <div class="t3p-umodal-actions">
          <div class="t3p-uhud-seg" data-role="range">
            <button type="button" data-range="1d" data-active="${prefs.range === "1d"}">今日</button>
            <button type="button" data-range="7d" data-active="${prefs.range === "7d"}">7 天</button>
            <button type="button" data-range="30d" data-active="${prefs.range === "30d"}">30 天</button>
          </div>
          <button type="button" class="t3p-umodal-btn" data-role="refresh">刷新</button>
          <button type="button" class="t3p-umodal-btn" data-role="close">关闭</button>
        </div>
      </div>

      <div class="t3p-umodal-body">
        <div class="t3p-umodal-kpis">
          <div class="t3p-umodal-kpi"><div class="k">总 Token</div><div class="v">${rangeReady ? formatTokens(t.totalTokens) : "—"}</div>${rangeReady ? `<div class="sub">输入 ${formatTokens(t.inputTokens)} / 输出 ${formatTokens(t.outputTokens)}</div>` : ""}</div>
          <div class="t3p-umodal-kpi"><div class="k">缓存命中率</div><div class="v">${rangeReady ? (t.cacheHitRate || 0) + "%" : "—"}</div>${rangeReady ? `<div class="sub">缓存命中 ${formatTokens(t.cachedInputTokens)}</div>` : ""}</div>
          <div class="t3p-umodal-kpi"><div class="k">估算费用</div><div class="v">${rangeReady ? formatCost(t.costUsd) : "—"}</div><div class="sub">含本地 Hermes 统计</div></div>
          <div class="t3p-umodal-kpi"><div class="k">平均速度</div><div class="v"${globalAvgSpeedColor ? ` style="color:${globalAvgSpeedColor};"` : ""}>${t.avgTokPerSec != null ? t.avgTokPerSec + "/s" : "—"}</div>${rangeReady ? `<div class="sub">记录事件 ${t.activeEvents || 0} 条</div>` : ""}</div>
        </div>

        <div class="t3p-umodal-panel">
          <div class="t3p-uhud-sec-hd">
            <span>订阅可用额度（Codex / Gemini / Claude & GPT）${creditNote ? " · " + escapeHtml(creditNote) : ""}</span>
          </div>
          <div class="t3p-uhud-qlist">
            ${renderQuotaRows(getOrderedQuotas(quotas), quotas.unavailable)}
          </div>
        </div>

        <div class="t3p-umodal-panel">
          <div class="t3p-uhud-sec-hd">
            <span>Token 消耗趋势 · ${escapeHtml(rangeLabel)}</span>
            <div class="t3p-uhud-seg" data-role="chart-type">
              <button type="button" data-chart="line" data-active="${prefs.chartType === "line"}">折线图</button>
              <button type="button" data-chart="heatmap" data-active="${prefs.chartType === "heatmap"}">热力图</button>
            </div>
          </div>
          ${chartHtml}
        </div>

        <div class="t3p-umodal-panel">
          <div class="t3p-uhud-sec-hd">
            <span>明细统计</span>
            <div class="t3p-uhud-seg" data-role="detail-tab">
              <button type="button" data-detail="providers" data-active="${prefs.detailTab === "providers"}">按订阅 / 模型</button>
              <button type="button" data-detail="turns" data-active="${prefs.detailTab === "turns"}">当前会话逐轮</button>
            </div>
          </div>
          ${
            prefs.detailTab === "turns"
              ? `<table class="t3p-umodal-table"><thead><tr><th>轮次</th><th>模型</th><th class="num">输出 / 思考</th><th class="num">首字延迟</th><th class="num">速度</th></tr></thead><tbody>${turnRowsHtml}</tbody></table>`
              : `<table class="t3p-umodal-table"><thead><tr><th>提供方 / 模型</th><th class="num">总 Token</th><th class="num">缓存率</th><th class="num">均速</th><th class="num">估算费用</th></tr></thead><tbody>${providerRowsHtml}</tbody></table>`
          }
        </div>
      </div>
    `;

    bindModalChartInteractions(modal);

    modal.querySelector('[data-role="close"]')?.addEventListener("click", closeUsageModal);
    modal.querySelector('[data-role="refresh"]')?.addEventListener("click", () => void fetchOverview(true));
    modal.querySelectorAll("[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextRange = btn.getAttribute("data-range");
        if (nextRange === prefs.range) return;
        void savePrefs({ range: nextRange });
        void fetchOverview(true);
        renderModal();
      });
    });
    modal.querySelectorAll("[data-chart]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await savePrefs({ chartType: btn.getAttribute("data-chart") });
        renderModal();
      });
    });
    modal.querySelectorAll("[data-detail]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await savePrefs({ detailTab: btn.getAttribute("data-detail") });
        renderModal();
      });
    });
  }

  function openUsageModal() {
    closeUsageModal();
    modalOpen = true;
    const backdrop = document.createElement("div");
    backdrop.className = "t3p-umodal-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeUsageModal();
    });
    const modal = document.createElement("div");
    modal.className = "t3p-umodal";
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modalBackdrop = backdrop;
    void fetchOverview(true);
    renderModal();
  }

  function collectTimelineRows(scroller) {
    if (!scroller) return [];
    let els = Array.from(scroller.querySelectorAll("[data-timeline-row-id]"));
    if (els.length === 0) {
      els = Array.from(scroller.querySelectorAll("[data-message-role]"));
    }
    return els.map((el, i) => {
      const message = el.matches("[data-message-role]") ? el : el.querySelector("[data-message-role]");
      const rawText = message?.textContent || "";
      return {
        el,
        rowId: el.getAttribute("data-timeline-row-id") || el.getAttribute("data-message-id") || `idx:${i}`,
        kind: el.getAttribute("data-timeline-row-kind") || "message",
        role: message?.getAttribute("data-message-role") || "",
        textLen: rawText.trim().length,
        rawLen: rawText.length,
        rawText,
      };
    });
  }

  function updateStreamingMetrics() {
    const scroller = document.querySelector(".messages-timeline-scroll");
    if (!scroller) return;

    const rowSnapshots = collectTimelineRows(scroller);
    const hasPendingIndicator = Boolean(
      document.querySelector('[data-chat-composer-form] [aria-label*="Stop"], [data-chat-composer-form] [aria-label*="停止"]')
    );

    const now = Date.now();
    if (hasPendingIndicator && !live.active) {
      const baseIds = new Set();
      let lastAssistantRowId = null;
      let lastAssistantLen = 0;
      for (const r of rowSnapshots) {
        if (r.rowId) baseIds.add(r.rowId);
        if (r.role === "assistant") {
          lastAssistantRowId = r.rowId;
          lastAssistantLen = r.textLen;
        }
      }
      live.active = true;
      live.threadId = activeThreadId || overviewData?.thread?.threadId || null;
      live.baselineRowIds = baseIds;
      live.baselineLastAssistantRowId = lastAssistantRowId;
      live.baselineLastAssistantLen = lastAssistantLen;
      const previousThread = overviewData?.thread;
      const previousTurn = previousThread?.threadId === live.threadId ? previousThread.turns?.[0] : null;
      live.previousRunId = previousTurn?.completedAt ? previousTurn.runId : null;
      live.streamRowId = null;
      live.streamBaselineLen = 0;
      live.streamLastLen = 0;
      live.textObserved = false;
      live.lastChangeMs = now;
      live.samples = [];
      live.liveTokPerSec = null;
      renderHud();
      return;
    }

    if (live.active) {
      const delta = detectFirstStreamingDelta(rowSnapshots, {
        rowIds: live.baselineRowIds,
        lastAssistantRowId: live.baselineLastAssistantRowId,
        lastAssistantLen: live.baselineLastAssistantLen,
      });

      if (delta.detected) {
        let shouldRender = false;
        if (!live.textObserved) {
          live.textObserved = true;
          void fetchOverview(true);
        }

        // Prefer latest active new output row for throughput measurement
        let targetRow = null;
        for (let i = rowSnapshots.length - 1; i >= 0; i--) {
          const r = rowSnapshots[i];
          if (r.role === "assistant" && !STREAM_IGNORED_KINDS.has(r.kind) && !live.baselineRowIds.has(r.rowId) && r.textLen > 0) {
            targetRow = r;
            break;
          }
        }
        if (!targetRow) {
          targetRow = rowSnapshots.find((r) => r.rowId === delta.rowId) || null;
        }

        if (targetRow) {
          if (targetRow.rowId !== live.streamRowId) {
            live.streamRowId = targetRow.rowId;
            live.streamBaselineLen = delta.isNewRow ? 0 : live.baselineLastAssistantLen;
            live.streamLastLen = targetRow.rawLen;
            live.samples = [];
            live.lastChangeMs = now;
          } else if (targetRow.rawLen > live.streamLastLen) {
            const deltaText = targetRow.rawText.slice(live.streamBaselineLen);
            const estTokens = estimateTokensFromText(deltaText);
            live.samples.push({ ts: now, tokens: estTokens });
            while (live.samples.length > 2 && now - live.samples[0].ts > 3500) {
              live.samples.shift();
            }
            if (live.samples.length >= 2) {
              const oldest = live.samples[0];
              const elapsedSec = (now - oldest.ts) / 1000;
              if (elapsedSec > 0.25) {
                live.liveTokPerSec = Math.max(0, (estTokens - oldest.tokens) / elapsedSec);
              }
            }
            live.streamLastLen = targetRow.rawLen;
            live.lastChangeMs = now;
            shouldRender = true;
          }
        }

        if (shouldRender) renderHud();
      }
      if (!hasPendingIndicator && now - live.lastChangeMs > 800) {
        live.active = false;
        void fetchOverview(true);
      }
    }
  }

  let observedCanvasEl = null;
  let canvasResizeObserver = null;
  const lastAppliedCenterByCanvas = new WeakMap();

  function clearChatCentering(canvas) {
    if (!canvas) return;
    if (canvas.getAttribute("data-t3p-chat-centered") !== null) {
      canvas.removeAttribute("data-t3p-chat-centered");
    }
    canvas.style?.removeProperty?.("--t3p-chat-inset-start");
    canvas.style?.removeProperty?.("--t3p-chat-inset-end");
    lastAppliedCenterByCanvas.delete(canvas);
  }

  function syncChatCentering() {
    const canvas = document.querySelector("[data-chat-canvas]");
    if (canvas && canvas !== observedCanvasEl && canvasResizeObserver) {
      try {
        canvasResizeObserver.disconnect();
        canvasResizeObserver.observe(canvas);
        observedCanvasEl = canvas;
      } catch {
        // ignore ResizeObserver failures
      }
    }
    if (!canvas) {
      observedCanvasEl = null;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const rootStyle = window.getComputedStyle(document.documentElement);
    const rootFs = parseFloat(rootStyle.fontSize) || 16;
    const basePadding = viewportWidth >= 640 ? 3 * rootFs : 0.75 * rootFs;

    const chatWidthAttr = document.documentElement.getAttribute("data-chat-width") || "";
    const laneEl =
      canvas.querySelector(".chat-content-lane") ||
      canvas.querySelector("[data-chat-composer-form]") ||
      document.querySelector("[data-chat-composer-form]");
    const rawMaxW = laneEl ? window.getComputedStyle(laneEl).maxWidth : "";
    const isFullWidth = chatWidthAttr === "full" || rawMaxW === "100%" || rawMaxW === "none";
    const parsedMaxW = /^[\d.]+px$/i.test(rawMaxW) ? parseFloat(rawMaxW) : NaN;
    const chatMaxWidth = Number.isFinite(parsedMaxW) && parsedMaxW > 0
      ? parsedMaxW
      : (chatWidthAttr === "wide" ? 72 * rootFs : 46 * rootFs);

    let detailsLeft = null;
    const inlinePanel = document.querySelector('[data-thread-details-panel="inline"]');
    if (inlinePanel) {
      const dRect = inlinePanel.getBoundingClientRect();
      if (dRect && dRect.width > 0 && dRect.height > 0) {
        detailsLeft = dRect.left;
      }
    }

    const nativeInsetEnd =
      parseFloat(window.getComputedStyle(canvas).getPropertyValue("--chat-lane-inset-end")) || 0;

    const res = computeScreenCenteredChatInsets({
      viewportWidth,
      canvasLeft: rect.left,
      canvasRight: rect.right,
      basePadding,
      chatMaxWidth,
      detailsLeft,
      nativeInsetEnd,
      isFullWidth,
    });

    if (!res.active) {
      clearChatCentering(canvas);
      return;
    }

    const prev = lastAppliedCenterByCanvas.get(canvas);
    const isSame =
      prev &&
      prev.insetStart === res.insetStart &&
      prev.insetEnd === res.insetEnd &&
      canvas.getAttribute("data-t3p-chat-centered") === "1";
    if (isSame) return;

    canvas.style.setProperty("--t3p-chat-inset-start", `${res.insetStart}px`);
    canvas.style.setProperty("--t3p-chat-inset-end", `${res.insetEnd}px`);
    if (canvas.getAttribute("data-t3p-chat-centered") !== "1") {
      canvas.setAttribute("data-t3p-chat-centered", "1");
    }
    lastAppliedCenterByCanvas.set(canvas, { insetStart: res.insetStart, insetEnd: res.insetEnd });
  }

  function syncHud() {
    syncChatCentering();
    const cardEl = findVisibleDetailsCard();
    if (!cardEl) {
      hudRoot = null;
      return;
    }

    suppressNativeUsageSections(cardEl);

    const nextThreadId = detectActiveThreadId(cardEl);
    const threadChanged = nextThreadId !== activeThreadId;
    if (threadChanged) {
      activeThreadId = nextThreadId;
      live.active = false;
      live.liveTokPerSec = null;
      live.baselineRowIds = new Set();
      live.baselineLastAssistantRowId = null;
      live.baselineLastAssistantLen = 0;
      live.previousRunId = null;
      live.streamRowId = null;
      live.streamBaselineLen = 0;
      live.streamLastLen = 0;
      live.samples = [];
    }

    const target = findHudMountTarget(cardEl);
    if (!hudRoot || !hudRoot.isConnected || hudRoot.parentElement !== target) {
      if (hudRoot && hudRoot.isConnected) hudRoot.remove();
      hudRoot = document.createElement("div");
      hudRoot.className = "t3p-uhud-root";
      hudRoot.setAttribute("data-t3p-usage-hud", "1");
      hudRoot.setAttribute("data-thread-details-server-overflow", "t3p-usage");
      target.appendChild(hudRoot);
      renderHud();
    }

    if (threadChanged || !overviewData || Date.now() - lastFetchMs > 30000) {
      void fetchOverview(threadChanged);
    }
  }

  function scheduleSync() {
    if (rafScheduled) return;
    rafScheduled = true;
    window.requestAnimationFrame(() => {
      rafScheduled = false;
      syncHud();
    });
  }

  async function init() {
    if (window.T3Plugins && typeof window.T3Plugins.getState === "function") {
      prefs = { ...DEFAULT_PREFS, ...(await window.T3Plugins.getState(PLUGIN_ID, DEFAULT_PREFS)) };
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modalOpen) closeUsageModal();
    });

    if (typeof ResizeObserver !== "undefined") {
      canvasResizeObserver = new ResizeObserver(() => scheduleSync());
    }
    window.addEventListener("resize", scheduleSync);
    document.addEventListener(
      "transitionend",
      (e) => {
        const prop = e?.propertyName || "";
        if (prop === "width" || prop === "left" || prop === "right" || prop === "transform" || prop === "padding-left" || prop === "padding-right") {
          scheduleSync();
        }
      },
      true
    );

    const observer = new MutationObserver((mutations) => {
      let hasDomChange = false;
      for (const m of mutations) {
        const targetEl = m.target && m.target.closest ? m.target : m.target?.parentElement;
        if (targetEl && targetEl.closest && (targetEl.closest("[data-t3p-usage-hud]") || targetEl.closest(".t3p-umodal-backdrop"))) {
          continue;
        }
        hasDomChange = true;
        if (m.type === "childList") {
          scheduleSync();
        }
      }
      if (hasDomChange) {
        updateStreamingMetrics();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    window.setInterval(() => {
      updateStreamingMetrics();
      if (findVisibleDetailsCard() || modalOpen) {
        if (Date.now() - lastFetchMs > 30000) {
          void fetchOverview(false);
        }
      }
    }, 250);

    scheduleSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
