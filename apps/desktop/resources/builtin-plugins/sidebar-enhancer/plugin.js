(() => {
  "use strict";

  const PLUGIN_ID = "sidebar-enhancer";
  const NATIVE_UI_STATE_KEY = "t3code:ui-state:v1";

  const PALETTE = [
    "#3b82f6",
    "#f59e0b",
    "#10b981",
    "#8b5cf6",
    "#ef4444",
    "#06b6d4",
    "#ec4899",
    "#f97316",
    "#84cc16",
    "#64748b",
  ];

  const DEFAULT_GROUPS = [
    { id: "friend-room", name: "好友房", color: "#3b82f6", collapsed: false, matchPrefix: "好友房" },
    { id: "gold-room", name: "金币房", color: "#f59e0b", collapsed: false, matchPrefix: "金币房" },
    { id: "other", name: "其他项目", color: "#8b5cf6", collapsed: false, matchPrefix: "" },
  ];

  const DEFAULT_TITLE_ORDER = {
    "friend-room": [
      "好友房报表",
      "好友房运营数据支持",
      "好友房月任务",
      "好友房周任务",
      "好友房数据字典同步",
      "好友房埋点整理",
    ],
    "gold-room": [
      "金币房报表",
      "金币房运营数据支持",
      "金币房月任务",
      "金币房数据字典同步",
      "金币房埋点整理",
    ],
    other: ["工作调度与工具维护", "chinese-boardgame-ai"],
  };

  const DEFAULT_TITLE_COLORS = {
    工作调度与工具维护: "#8b5cf6",
    "chinese-boardgame-ai": "#10b981",
  };

  function cloneDefaultGroups() {
    return DEFAULT_GROUPS.map((g) => ({ ...g }));
  }

  function createDefaultState() {
    return {
      version: 1,
      groupingEnabled: true,
      syncNativeOrder: true,
      filterGroupId: "all",
      groups: cloneDefaultGroups(),
      defaultTitleOrder: { ...DEFAULT_TITLE_ORDER },
      defaultTitleColors: { ...DEFAULT_TITLE_COLORS },
      projectGroups: {},
      projectOrder: [],
      projectColors: {},
    };
  }

  function normalizeState(raw) {
    const base = createDefaultState();
    if (!raw || typeof raw !== "object") return base;
    const groups = Array.isArray(raw.groups) && raw.groups.length > 0
      ? raw.groups
          .filter((g) => g && typeof g.id === "string" && g.id.trim())
          .map((g) => ({
            id: g.id.trim(),
            name: typeof g.name === "string" && g.name.trim() ? g.name.trim() : g.id.trim(),
            color: typeof g.color === "string" ? g.color : "#64748b",
            collapsed: Boolean(g.collapsed),
            matchPrefix: typeof g.matchPrefix === "string" ? g.matchPrefix : "",
          }))
      : cloneDefaultGroups();

    const groupIds = new Set(groups.map((g) => g.id));
    const filterGroupId =
      typeof raw.filterGroupId === "string" && (raw.filterGroupId === "all" || groupIds.has(raw.filterGroupId))
        ? raw.filterGroupId
        : "all";

    return {
      version: 1,
      groupingEnabled: raw.groupingEnabled !== false,
      syncNativeOrder: raw.syncNativeOrder !== false,
      filterGroupId,
      groups,
      defaultTitleOrder:
        raw.defaultTitleOrder && typeof raw.defaultTitleOrder === "object"
          ? raw.defaultTitleOrder
          : { ...DEFAULT_TITLE_ORDER },
      defaultTitleColors:
        raw.defaultTitleColors && typeof raw.defaultTitleColors === "object"
          ? raw.defaultTitleColors
          : { ...DEFAULT_TITLE_COLORS },
      projectGroups:
        raw.projectGroups && typeof raw.projectGroups === "object" ? { ...raw.projectGroups } : {},
      projectOrder: Array.isArray(raw.projectOrder)
        ? raw.projectOrder.filter((x) => typeof x === "string" && x.length > 0)
        : [],
      projectColors:
        raw.projectColors && typeof raw.projectColors === "object" ? { ...raw.projectColors } : {},
    };
  }

  function resolveProjectGroup(project, state) {
    const groups = state.groups;
    const validIds = new Set(groups.map((g) => g.id));
    const explicit = state.projectGroups?.[project.rowKey];
    if (explicit && validIds.has(explicit)) {
      return explicit;
    }
    const title = project.title || "";
    for (const g of groups) {
      if (g.matchPrefix && title.startsWith(g.matchPrefix)) {
        return g.id;
      }
    }
    if (validIds.has("other")) return "other";
    return groups[groups.length - 1]?.id || "other";
  }

  function resolveProjectColor(project, state, resolvedGroupId) {
    if (state.projectColors && Object.prototype.hasOwnProperty.call(state.projectColors, project.rowKey)) {
      const val = state.projectColors[project.rowKey];
      return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
    }
    if (state.defaultTitleColors && Object.prototype.hasOwnProperty.call(state.defaultTitleColors, project.title)) {
      const val = state.defaultTitleColors[project.title];
      if (typeof val === "string" && val.trim().length > 0) return val.trim();
    }
    const g = state.groups.find((item) => item.id === resolvedGroupId);
    return g && g.color ? g.color : null;
  }

  function compareWithinBucket(a, b, orderMap, defaultList) {
    const ia = orderMap.has(a.rowKey) ? orderMap.get(a.rowKey) : Number.MAX_SAFE_INTEGER;
    const ib = orderMap.has(b.rowKey) ? orderMap.get(b.rowKey) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;

    if (Array.isArray(defaultList) && defaultList.length > 0) {
      const da = defaultList.indexOf(a.title);
      const db = defaultList.indexOf(b.title);
      const va = da === -1 ? Number.MAX_SAFE_INTEGER : da;
      const vb = db === -1 ? Number.MAX_SAFE_INTEGER : db;
      if (va !== vb) return va - vb;
    }

    return a.domIndex - b.domIndex;
  }

  function computeLayout(projects, rawState, searchQuery = "") {
    const state = normalizeState(rawState);
    const orderMap = new Map();
    state.projectOrder.forEach((rk, idx) => orderMap.set(rk, idx));

    const q = (searchQuery || "").trim().toLowerCase();
    const activeFilterGroup = state.filterGroupId || "all";
    const isFiltering = q.length > 0 || (state.groupingEnabled && activeFilterGroup !== "all");

    const byGroup = new Map();
    for (const g of state.groups) {
      byGroup.set(g.id, []);
    }

    const projectPlacements = new Map();
    for (const p of projects) {
      const gid = resolveProjectGroup(p, state);
      if (!byGroup.has(gid)) {
        byGroup.set(gid, []);
      }
      byGroup.get(gid).push(p);
    }

    const orderedAllRowKeys = [];
    const groupLayouts = [];

    if (state.groupingEnabled) {
      state.groups.forEach((g, gIdx) => {
        const list = [...(byGroup.get(g.id) || [])];
        const defList = state.defaultTitleOrder?.[g.id] || [];
        list.sort((a, b) => compareWithinBucket(a, b, orderMap, defList));

        const groupOrder = (gIdx + 1) * 100000;
        let matchingCount = 0;

        list.forEach((p, pIdx) => {
          orderedAllRowKeys.push(p.rowKey);
          const matchesQuery = !q || (p.title || "").toLowerCase().includes(q);
          const matchesFilter = activeFilterGroup === "all" || activeFilterGroup === g.id;
          const matches = matchesQuery && matchesFilter;
          if (matches) matchingCount += 1;

          const visible = isFiltering ? matches : !g.collapsed;
          const order = groupOrder + (pIdx + 1) * 1000;
          const color = resolveProjectColor(p, state, g.id);

          projectPlacements.set(p.rowKey, {
            rowKey: p.rowKey,
            groupId: g.id,
            order,
            visible,
            color,
            matches,
          });
        });

        const headerVisible = isFiltering ? matchingCount > 0 : true;
        groupLayouts.push({
          group: g,
          order: groupOrder,
          totalCount: list.length,
          matchingCount,
          visible: headerVisible,
          items: list,
        });
      });
    } else {
      const flat = [...projects];
      const groupRank = new Map(state.groups.map((g, i) => [g.id, i]));
      flat.sort((a, b) => {
        const ia = orderMap.has(a.rowKey) ? orderMap.get(a.rowKey) : Number.MAX_SAFE_INTEGER;
        const ib = orderMap.has(b.rowKey) ? orderMap.get(b.rowKey) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        const ga = resolveProjectGroup(a, state);
        const gb = resolveProjectGroup(b, state);
        const ra = groupRank.get(ga) ?? 999;
        const rb = groupRank.get(gb) ?? 999;
        if (ra !== rb) return ra - rb;
        return compareWithinBucket(a, b, orderMap, state.defaultTitleOrder?.[ga] || []);
      });

      flat.forEach((p, idx) => {
        orderedAllRowKeys.push(p.rowKey);
        const gid = resolveProjectGroup(p, state);
        const matches = !q || (p.title || "").toLowerCase().includes(q);
        projectPlacements.set(p.rowKey, {
          rowKey: p.rowKey,
          groupId: gid,
          order: 100000 + (idx + 1) * 1000,
          visible: matches,
          color: resolveProjectColor(p, state, gid),
          matches,
        });
      });

      state.groups.forEach((g, gIdx) => {
        groupLayouts.push({
          group: g,
          order: (gIdx + 1) * 100000,
          totalCount: (byGroup.get(g.id) || []).length,
          matchingCount: 0,
          visible: false,
          items: [],
        });
      });
    }

    return {
      isFiltering,
      orderedAllRowKeys,
      groupLayouts,
      projectPlacements,
    };
  }

  function mergeUnknownOrderKeys(orderedVisibleKeys, existingOrder) {
    const seen = new Set(orderedVisibleKeys);
    const tail = (existingOrder || []).filter((k) => !seen.has(k));
    return [...orderedVisibleKeys, ...tail];
  }

  function moveProject(projects, rawState, draggedRowKey, targetRowKey, position = "before", targetGroupId = null) {
    const state = normalizeState(rawState);
    if (!draggedRowKey) return state;
    if (draggedRowKey === targetRowKey) return state;

    const layout = computeLayout(projects, state, "");
    const nextProjectGroups = { ...state.projectGroups };
    const knownKeys = new Set(projects.map((p) => p.rowKey));
    if (!knownKeys.has(draggedRowKey)) return state;

    if (!state.groupingEnabled) {
      const list = layout.orderedAllRowKeys.filter((k) => k !== draggedRowKey);
      if (targetRowKey && list.includes(targetRowKey)) {
        const idx = list.indexOf(targetRowKey);
        const insertAt = position === "after" ? idx + 1 : idx;
        list.splice(insertAt, 0, draggedRowKey);
      } else {
        list.push(draggedRowKey);
      }
      return {
        ...state,
        projectGroups: nextProjectGroups,
        projectOrder: mergeUnknownOrderKeys(list, state.projectOrder),
      };
    }

    const buckets = new Map();
    for (const gl of layout.groupLayouts) {
      buckets.set(
        gl.group.id,
        gl.items.map((p) => p.rowKey).filter((k) => k !== draggedRowKey)
      );
    }

    let destGroupId = targetGroupId;
    if (!destGroupId && targetRowKey) {
      const targetPlacement = layout.projectPlacements.get(targetRowKey);
      destGroupId = targetPlacement ? targetPlacement.groupId : null;
    }
    if (!destGroupId || !buckets.has(destGroupId)) {
      destGroupId = state.groups[0]?.id || "other";
    }

    const destList = buckets.get(destGroupId);
    if (targetRowKey && destList.includes(targetRowKey)) {
      const idx = destList.indexOf(targetRowKey);
      const insertAt = position === "after" ? idx + 1 : idx;
      destList.splice(insertAt, 0, draggedRowKey);
    } else {
      destList.push(draggedRowKey);
    }

    nextProjectGroups[draggedRowKey] = destGroupId;

    const flattened = [];
    const nextGroups = state.groups.map((g) => {
      const items = buckets.get(g.id) || [];
      flattened.push(...items);
      if (g.id === destGroupId && g.collapsed && !targetRowKey) {
        return { ...g, collapsed: false };
      }
      return g;
    });

    return {
      ...state,
      groups: nextGroups,
      projectGroups: nextProjectGroups,
      projectOrder: mergeUnknownOrderKeys(flattened, state.projectOrder),
    };
  }

  function moveGroup(rawState, draggedGroupId, targetGroupId, position = "before") {
    const state = normalizeState(rawState);
    if (!draggedGroupId || !targetGroupId || draggedGroupId === targetGroupId) return state;
    const fromIdx = state.groups.findIndex((g) => g.id === draggedGroupId);
    if (fromIdx === -1) return state;

    const groups = [...state.groups];
    const [moved] = groups.splice(fromIdx, 1);
    const toIdx = groups.findIndex((g) => g.id === targetGroupId);
    if (toIdx === -1) {
      groups.push(moved);
    } else {
      groups.splice(position === "after" ? toIdx + 1 : toIdx, 0, moved);
    }
    return { ...state, groups };
  }

  const Core = {
    PALETTE,
    DEFAULT_GROUPS,
    DEFAULT_TITLE_ORDER,
    DEFAULT_TITLE_COLORS,
    createDefaultState,
    normalizeState,
    resolveProjectGroup,
    resolveProjectColor,
    computeLayout,
    moveProject,
    moveGroup,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Core;
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  window.__T3SidebarEnhancerCore = Core;

  if (window.__T3_SIDEBAR_ENHANCER_MOUNTED__) return;
  window.__T3_SIDEBAR_ENHANCER_MOUNTED__ = true;

  if (window.T3Plugins && typeof window.T3Plugins.register === "function") {
    window.T3Plugins.register({
      id: PLUGIN_ID,
      name: "侧边栏增强",
      version: "1.0.0",
    });
  }

  let state = createDefaultState();
  let searchQuery = "";
  let activeUl = null;
  let toolbarLi = null;
  let groupHeaderMap = new Map();
  let dragState = null; // { kind: 'project' | 'group', id: string }
  let activePopover = null;
  let activeModal = null;
  let rafScheduled = false;
  let isApplying = false;

  const SVG_NS = "http://www.w3.org/2000/svg";

  function makeSvg(paths, size = 14) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  function syncNativeProjectOrder(orderedRowKeys) {
    if (!state.syncNativeOrder) return;
    try {
      const raw = window.localStorage.getItem(NATIVE_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const nextOrder = orderedRowKeys.map((rk) => (rk.startsWith("folder:") ? rk.slice(7) : rk));
      const prevOrder = Array.isArray(parsed.projectOrder) ? parsed.projectOrder : [];
      if (prevOrder.length === nextOrder.length && prevOrder.every((v, i) => v === nextOrder[i])) {
        return;
      }
      parsed.projectOrder = nextOrder;
      window.localStorage.setItem(NATIVE_UI_STATE_KEY, JSON.stringify(parsed));
    } catch {
      // ignore localStorage errors
    }
  }

  async function persistState(nextState, syncNative = true) {
    state = normalizeState(nextState);
    if (syncNative) {
      syncNativeProjectOrder(state.projectOrder);
    }
    if (window.T3Plugins && typeof window.T3Plugins.saveState === "function") {
      await window.T3Plugins.saveState(PLUGIN_ID, state);
    } else {
      try {
        window.localStorage.setItem("t3p:state:" + PLUGIN_ID, JSON.stringify(state));
      } catch {
        // ignore
      }
    }
  }

  function findSidebarUl() {
    const folderNodes = document.querySelectorAll('li[data-testid="sidebar-project-folder"]');
    for (const li of folderNodes) {
      const ul = li.parentElement;
      if (ul && ul.tagName === "UL" && ul.id !== "sidebar-thread-search-results") {
        return ul;
      }
    }
    return null;
  }

  function extractSidebarData(ul) {
    const children = Array.from(ul.children);
    const projects = [];
    const folderSet = new Set();
    const threadsByParent = new Map();
    const otherLis = [];

    let firstFolderDomIdx = -1;
    let lastFolderDomIdx = -1;

    children.forEach((li, domIdx) => {
      if (li.tagName !== "LI") return;
      if (li.hasAttribute("data-t3p-role")) return;
      if (li.matches('li[data-testid="sidebar-project-folder"]')) {
        if (firstFolderDomIdx === -1) firstFolderDomIdx = domIdx;
        lastFolderDomIdx = domIdx;
        folderSet.add(li);
        const btn = li.querySelector("button[data-sidebar-row]");
        const rowKey = btn?.getAttribute("data-sidebar-row") || "";
        const titleEl = btn?.querySelector("span.truncate");
        const title = titleEl?.textContent?.trim() || btn?.textContent?.trim() || "";
        if (rowKey) {
          projects.push({
            rowKey,
            projectKey: rowKey.startsWith("folder:") ? rowKey.slice(7) : rowKey,
            title,
            domIndex: domIdx,
            li,
          });
        }
        return;
      }

      const parentMarker = li.querySelector("[data-sidebar-parent]");
      const parentKey = parentMarker?.getAttribute("data-sidebar-parent") || "";
      if (parentKey.startsWith("folder:")) {
        if (!threadsByParent.has(parentKey)) threadsByParent.set(parentKey, []);
        threadsByParent.get(parentKey).push({ li, domIdx });
        return;
      }

      otherLis.push({ li, domIdx, parentKey });
    });

    const topLis = [];
    const bottomLis = [];
    for (const item of otherLis) {
      const rowKey = item.li.querySelector("[data-sidebar-row]")?.getAttribute("data-sidebar-row") || "";
      const isShelf =
        item.parentKey.startsWith("shelf:") ||
        rowKey.startsWith("working-") ||
        rowKey.startsWith("snoozed-") ||
        rowKey.startsWith("settled-") ||
        rowKey === "settled:more" ||
        (lastFolderDomIdx !== -1 && item.domIdx > lastFolderDomIdx) ||
        (firstFolderDomIdx !== -1 && item.domIdx > firstFolderDomIdx);
      if (isShelf) {
        bottomLis.push(item);
      } else {
        topLis.push(item);
      }
    }

    return { projects, threadsByParent, topLis, bottomLis };
  }

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function openColorPopover(anchorBtn, project) {
    closePopover();
    const pop = document.createElement("div");
    pop.className = "t3p-color-popover";

    const title = document.createElement("div");
    title.className = "t3p-color-popover-title";
    title.textContent = `颜色标记 · ${project.title}`;
    pop.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "t3p-color-grid";

    const currentColor = resolveProjectColor(
      project,
      state,
      resolveProjectGroup(project, state)
    );

    for (const hex of PALETTE) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "t3p-swatch";
      sw.style.backgroundColor = hex;
      sw.title = hex;
      if (currentColor && currentColor.toLowerCase() === hex.toLowerCase()) {
        sw.dataset.selected = "true";
      }
      sw.addEventListener("click", async (e) => {
        e.stopPropagation();
        closePopover();
        const nextColors = { ...state.projectColors, [project.rowKey]: hex };
        await persistState({ ...state, projectColors: nextColors }, false);
        scheduleSync();
      });
      grid.appendChild(sw);
    }
    pop.appendChild(grid);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "t3p-clear-color-btn";
    clearBtn.textContent = "清除颜色标记";
    clearBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closePopover();
      const nextColors = { ...state.projectColors, [project.rowKey]: "" };
      await persistState({ ...state, projectColors: nextColors }, false);
      scheduleSync();
    });
    pop.appendChild(clearBtn);

    document.body.appendChild(pop);
    const rect = anchorBtn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const left = Math.min(window.innerWidth - popRect.width - 8, Math.max(8, rect.left));
    const top = Math.min(window.innerHeight - popRect.height - 8, rect.bottom + 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    activePopover = pop;
  }

  function ensureFolderControls(project, placement) {
    const li = project.li;
    li.classList.add("t3p-enhanced");
    if (li.getAttribute("draggable") !== "true") {
      li.setAttribute("draggable", "true");
    }
    li.dataset.t3pRowKey = project.rowKey;

    if (placement.color) {
      if (li.dataset.t3pColor !== placement.color) {
        li.dataset.t3pColor = placement.color;
        li.style.setProperty("--t3p-color", placement.color);
      }
    } else if (li.hasAttribute("data-t3p-color")) {
      li.removeAttribute("data-t3p-color");
      li.style.removeProperty("--t3p-color");
    }

    let controls = li.querySelector(":scope > [data-t3p-controls]");
    if (!controls) {
      controls = document.createElement("span");
      controls.className = "t3p-folder-controls";
      controls.setAttribute("data-t3p-controls", "1");

      const colorBtn = document.createElement("button");
      colorBtn.type = "button";
      colorBtn.className = "t3p-color-btn";
      colorBtn.setAttribute("data-t3p-color-btn", "1");
      colorBtn.title = "设置项目颜色标记";
      const miniSwatch = document.createElement("span");
      miniSwatch.className = "t3p-color-swatch-mini";
      colorBtn.appendChild(miniSwatch);

      colorBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      colorBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openColorPopover(colorBtn, {
          rowKey: li.dataset.t3pRowKey || project.rowKey,
          title: li.querySelector("button[data-sidebar-row] span.truncate")?.textContent?.trim() || project.title,
        });
      });

      const grip = document.createElement("span");
      grip.className = "t3p-drag-grip";
      grip.setAttribute("data-t3p-grip", "1");
      grip.title = "拖动调整项目顺序或分组";
      grip.appendChild(
        makeSvg(
          [
            "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
          ],
          13
        )
      );
      grip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      controls.appendChild(colorBtn);
      controls.appendChild(grip);
      li.appendChild(controls);
    }

    const miniSwatch = controls.querySelector(".t3p-color-swatch-mini");
    if (miniSwatch) {
      const targetBg = placement.color || "transparent";
      if (miniSwatch.style.backgroundColor !== targetBg) {
        miniSwatch.style.backgroundColor = targetBg;
      }
    }
  }

  function ensureToolbar(ul) {
    if (!toolbarLi || !toolbarLi.isConnected) {
      toolbarLi = document.createElement("li");
      toolbarLi.className = "t3p-toolbar-li";
      toolbarLi.setAttribute("data-t3p-role", "toolbar");

      const topRow = document.createElement("div");
      topRow.className = "t3p-toolbar-top";

      const searchWrap = document.createElement("div");
      searchWrap.className = "t3p-search-wrap";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "t3p-search-input";
      input.placeholder = "过滤项目...";
      input.setAttribute("aria-label", "过滤侧边栏项目");
      input.value = searchQuery;

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "t3p-search-clear t3p-hidden";
      clearBtn.textContent = "×";
      clearBtn.title = "清除过滤";

      input.addEventListener("input", () => {
        searchQuery = input.value;
        clearBtn.classList.toggle("t3p-hidden", searchQuery.length === 0);
        scheduleSync();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && searchQuery) {
          e.stopPropagation();
          searchQuery = "";
          input.value = "";
          clearBtn.classList.add("t3p-hidden");
          scheduleSync();
        }
      });
      clearBtn.addEventListener("click", () => {
        searchQuery = "";
        input.value = "";
        clearBtn.classList.add("t3p-hidden");
        input.focus();
        scheduleSync();
      });

      searchWrap.appendChild(input);
      searchWrap.appendChild(clearBtn);

      const toggleAllBtn = document.createElement("button");
      toggleAllBtn.type = "button";
      toggleAllBtn.className = "t3p-icon-btn";
      toggleAllBtn.setAttribute("data-t3p-toggle-all", "1");
      toggleAllBtn.title = "全部展开 / 折叠分组";
      toggleAllBtn.appendChild(
        makeSvg(["M7 15l5 5 5-5", "M7 9l5-5 5 5"], 14)
      );
      toggleAllBtn.addEventListener("click", async () => {
        const anyExpanded = state.groups.some((g) => !g.collapsed);
        const nextGroups = state.groups.map((g) => ({ ...g, collapsed: anyExpanded }));
        await persistState({ ...state, groupingEnabled: true, groups: nextGroups }, false);
        scheduleSync();
      });

      const gearBtn = document.createElement("button");
      gearBtn.type = "button";
      gearBtn.className = "t3p-icon-btn";
      gearBtn.title = "管理分组、排序与本地插件";
      gearBtn.appendChild(
        makeSvg(
          [
            "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
            "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
          ],
          14
        )
      );
      gearBtn.addEventListener("click", () => openManagerModal("groups"));

      topRow.appendChild(searchWrap);
      topRow.appendChild(toggleAllBtn);
      topRow.appendChild(gearBtn);
      toolbarLi.appendChild(topRow);

      const pillsRow = document.createElement("div");
      pillsRow.className = "t3p-pills-row";
      toolbarLi.appendChild(pillsRow);
    }

    if (toolbarLi.parentElement !== ul) {
      ul.appendChild(toolbarLi);
    }

    const pillsRow = toolbarLi.querySelector(".t3p-pills-row");
    if (pillsRow) {
      pillsRow.classList.toggle("t3p-hidden", !state.groupingEnabled);
      if (state.groupingEnabled) {
        const sig = JSON.stringify([
          state.filterGroupId,
          state.groups.map((g) => [g.id, g.name, g.color]),
        ]);
        if (pillsRow.dataset.sig !== sig) {
          pillsRow.dataset.sig = sig;
          pillsRow.replaceChildren();

          const makePill = (id, label, color) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "t3p-pill";
            btn.dataset.active = state.filterGroupId === id ? "true" : "false";
            if (color) {
              const dot = document.createElement("span");
              dot.className = "t3p-dot";
              dot.style.backgroundColor = color;
              btn.appendChild(dot);
            }
            const span = document.createElement("span");
            span.textContent = label;
            btn.appendChild(span);
            btn.addEventListener("click", async () => {
              const nextFilter = id === "all" ? "all" : state.filterGroupId === id ? "all" : id;
              await persistState({ ...state, filterGroupId: nextFilter }, false);
              scheduleSync();
            });
            return btn;
          };

          pillsRow.appendChild(makePill("all", "全部", null));
          for (const g of state.groups) {
            pillsRow.appendChild(makePill(g.id, g.name, g.color));
          }
        }
      }
    }
  }

  function ensureGroupHeader(ul, gl, isFiltering) {
    const g = gl.group;
    let li = groupHeaderMap.get(g.id);
    if (!li || !li.isConnected) {
      li = document.createElement("li");
      li.className = "t3p-group-header";
      li.setAttribute("data-t3p-role", "group-header");
      li.setAttribute("data-t3p-group-id", g.id);
      li.setAttribute("draggable", "true");

      const chevron = makeSvg(["M6 9l6 6 6-6"], 12);
      chevron.setAttribute("class", "t3p-group-chevron");

      const dot = document.createElement("span");
      dot.className = "t3p-dot";

      const nameEl = document.createElement("span");
      nameEl.className = "t3p-group-name";

      const countEl = document.createElement("span");
      countEl.className = "t3p-group-count";

      const grip = document.createElement("span");
      grip.className = "t3p-group-grip";
      grip.title = "拖动调整分组顺序";
      grip.appendChild(makeSvg(["M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"], 12));

      li.appendChild(chevron);
      li.appendChild(dot);
      li.appendChild(nameEl);
      li.appendChild(countEl);
      li.appendChild(grip);

      li.addEventListener("click", async (e) => {
        if (e.target.closest(".t3p-group-grip")) return;
        const gid = li.getAttribute("data-t3p-group-id");
        const nextGroups = state.groups.map((item) =>
          item.id === gid ? { ...item, collapsed: !item.collapsed } : item
        );
        await persistState({ ...state, groups: nextGroups }, false);
        scheduleSync();
      });

      groupHeaderMap.set(g.id, li);
    }

    if (li.parentElement !== ul) {
      ul.appendChild(li);
    }

    li.dataset.collapsed = !isFiltering && g.collapsed ? "true" : "false";
    li.classList.toggle("t3p-hidden", !gl.visible);
    if (li.style.order !== String(gl.order)) {
      li.style.order = String(gl.order);
    }

    const dot = li.querySelector(".t3p-dot");
    if (dot && dot.style.backgroundColor !== (g.color || "#64748b")) {
      dot.style.backgroundColor = g.color || "#64748b";
    }
    const nameEl = li.querySelector(".t3p-group-name");
    if (nameEl && nameEl.textContent !== g.name) {
      nameEl.textContent = g.name;
    }
    const countEl = li.querySelector(".t3p-group-count");
    const countText = isFiltering ? `${gl.matchingCount}/${gl.totalCount}` : String(gl.totalCount);
    if (countEl && countEl.textContent !== countText) {
      countEl.textContent = countText;
    }
  }

  function clearDragVisuals() {
    if (!activeUl) return;
    for (const el of activeUl.querySelectorAll(".t3p-dragging, .t3p-drop-before, .t3p-drop-after, .t3p-drop-inside")) {
      el.classList.remove("t3p-dragging", "t3p-drop-before", "t3p-drop-after", "t3p-drop-inside");
    }
  }

  function attachUlDragHandlers(ul) {
    if (ul.dataset.t3pDndBound === "1") return;
    ul.dataset.t3pDndBound = "1";

    ul.addEventListener("dragstart", (e) => {
      const folderLi = e.target.closest?.('li[data-testid="sidebar-project-folder"]');
      if (folderLi && folderLi.parentElement === ul) {
        const rowKey = folderLi.dataset.t3pRowKey || folderLi.querySelector("button[data-sidebar-row]")?.getAttribute("data-sidebar-row");
        if (!rowKey) return;
        dragState = { kind: "project", id: rowKey, el: folderLi };
        folderLi.classList.add("t3p-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-t3p-project", rowKey);
        }
        e.stopPropagation();
        return;
      }

      const groupLi = e.target.closest?.('li[data-t3p-role="group-header"]');
      if (groupLi && groupLi.parentElement === ul) {
        const gid = groupLi.getAttribute("data-t3p-group-id");
        if (!gid) return;
        dragState = { kind: "group", id: gid, el: groupLi };
        groupLi.classList.add("t3p-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-t3p-group", gid);
        }
        e.stopPropagation();
      }
    });

    ul.addEventListener("dragover", (e) => {
      if (!dragState) return;

      const targetFolder = e.target.closest?.('li[data-testid="sidebar-project-folder"]');
      const targetGroup = e.target.closest?.('li[data-t3p-role="group-header"]');

      if (dragState.kind === "project" && targetFolder && targetFolder.parentElement === ul) {
        const targetKey = targetFolder.dataset.t3pRowKey;
        if (!targetKey || targetKey === dragState.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        clearDragVisuals();
        if (dragState.el) dragState.el.classList.add("t3p-dragging");
        const rect = targetFolder.getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;
        targetFolder.classList.add(isAfter ? "t3p-drop-after" : "t3p-drop-before");
        return;
      }

      if (targetGroup && targetGroup.parentElement === ul) {
        const gid = targetGroup.getAttribute("data-t3p-group-id");
        if (!gid) return;
        if (dragState.kind === "group" && gid === dragState.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        clearDragVisuals();
        if (dragState.el) dragState.el.classList.add("t3p-dragging");
        if (dragState.kind === "project") {
          targetGroup.classList.add("t3p-drop-inside");
        } else {
          const rect = targetGroup.getBoundingClientRect();
          const isAfter = e.clientY > rect.top + rect.height / 2;
          targetGroup.classList.add(isAfter ? "t3p-drop-after" : "t3p-drop-before");
        }
      }
    });

    ul.addEventListener("dragleave", (e) => {
      if (!dragState) return;
      if (!ul.contains(e.relatedTarget)) {
        clearDragVisuals();
        if (dragState.el) dragState.el.classList.add("t3p-dragging");
      }
    });

    ul.addEventListener("drop", async (e) => {
      if (!dragState) return;
      const currentDrag = dragState;
      const targetFolder = e.target.closest?.('li[data-t3p-role]') ? null : e.target.closest?.('li[data-testid="sidebar-project-folder"]');
      const targetGroup = e.target.closest?.('li[data-t3p-role="group-header"]');

      clearDragVisuals();
      dragState = null;

      if (currentDrag.kind === "project") {
        const { projects } = extractSidebarData(ul);
        if (targetFolder && targetFolder.parentElement === ul) {
          const targetKey = targetFolder.dataset.t3pRowKey;
          if (!targetKey || targetKey === currentDrag.id) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = targetFolder.getBoundingClientRect();
          const pos = e.clientY > rect.top + rect.height / 2 ? "after" : "before";
          const next = moveProject(projects, state, currentDrag.id, targetKey, pos, null);
          await persistState(next, true);
          scheduleSync();
          return;
        }
        if (targetGroup && targetGroup.parentElement === ul) {
          const gid = targetGroup.getAttribute("data-t3p-group-id");
          if (!gid) return;
          e.preventDefault();
          e.stopPropagation();
          const next = moveProject(projects, state, currentDrag.id, null, "after", gid);
          await persistState(next, true);
          scheduleSync();
        }
      } else if (currentDrag.kind === "group" && targetGroup && targetGroup.parentElement === ul) {
        const targetGid = targetGroup.getAttribute("data-t3p-group-id");
        if (!targetGid || targetGid === currentDrag.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = targetGroup.getBoundingClientRect();
        const pos = e.clientY > rect.top + rect.height / 2 ? "after" : "before";
        const next = moveGroup(state, currentDrag.id, targetGid, pos);
        const { projects } = extractSidebarData(ul);
        const rebuilt = computeLayout(projects, next, "");
        await persistState(
          { ...next, projectOrder: mergeUnknownOrderKeys(rebuilt.orderedAllRowKeys, next.projectOrder) },
          true
        );
        scheduleSync();
      }
    });

    ul.addEventListener("dragend", () => {
      dragState = null;
      clearDragVisuals();
    });
  }

  function syncSidebar() {
    if (isApplying) return;
    isApplying = true;
    try {
      const ul = findSidebarUl();
      if (!ul) {
        if (toolbarLi && toolbarLi.isConnected) toolbarLi.remove();
        for (const h of groupHeaderMap.values()) {
          if (h.isConnected) h.remove();
        }
        activeUl = null;
        return;
      }

      activeUl = ul;
      attachUlDragHandlers(ul);
      ensureToolbar(ul);

      const { projects, threadsByParent, topLis, bottomLis } = extractSidebarData(ul);
      const layout = computeLayout(projects, state, searchQuery);

      // Remove stale group header elements
      const activeGroupIds = new Set(state.groups.map((g) => g.id));
      for (const [gid, headerLi] of groupHeaderMap.entries()) {
        if (!activeGroupIds.has(gid)) {
          headerLi.remove();
          groupHeaderMap.delete(gid);
        }
      }

      for (const gl of layout.groupLayouts) {
        ensureGroupHeader(ul, gl, layout.isFiltering);
      }

      for (const item of topLis) {
        const orderStr = String(-100000 + item.domIdx);
        if (item.li.style.order !== orderStr) item.li.style.order = orderStr;
      }

      for (const item of bottomLis) {
        const orderStr = String(9000000 + item.domIdx);
        if (item.li.style.order !== orderStr) item.li.style.order = orderStr;
      }

      for (const p of projects) {
        const placement = layout.projectPlacements.get(p.rowKey);
        if (!placement) continue;
        ensureFolderControls(p, placement);
        const orderStr = String(placement.order);
        if (p.li.style.order !== orderStr) p.li.style.order = orderStr;
        p.li.classList.toggle("t3p-hidden", !placement.visible);

        const threads = threadsByParent.get(p.rowKey) || [];
        threads.forEach((t, tIdx) => {
          const tOrder = String(placement.order + tIdx + 1);
          if (t.li.style.order !== tOrder) t.li.style.order = tOrder;
          t.li.classList.toggle("t3p-hidden", !placement.visible);
        });
      }

      syncNativeProjectOrder(layout.orderedAllRowKeys);
    } finally {
      isApplying = false;
    }
  }

  function scheduleSync() {
    if (rafScheduled) return;
    rafScheduled = true;
    window.requestAnimationFrame(() => {
      rafScheduled = false;
      syncSidebar();
    });
  }

  function closeModal() {
    if (activeModal) {
      activeModal.remove();
      activeModal = null;
    }
  }

  function openManagerModal(initialTab = "groups") {
    closeModal();
    closePopover();
    let currentTab = initialTab;

    const backdrop = document.createElement("div");
    backdrop.className = "t3p-modal-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });

    const modal = document.createElement("div");
    modal.className = "t3p-modal";
    backdrop.appendChild(modal);

    function renderModal() {
      modal.replaceChildren();

      const header = document.createElement("div");
      header.className = "t3p-modal-header";
      const title = document.createElement("div");
      title.className = "t3p-modal-title";
      title.textContent = "QUI 侧边栏增强 & 本地插件";
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "t3p-btn";
      closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", closeModal);
      header.appendChild(title);
      header.appendChild(closeBtn);
      modal.appendChild(header);

      const tabs = document.createElement("div");
      tabs.className = "t3p-modal-tabs";
      const mkTab = (id, label) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "t3p-tab-btn";
        b.dataset.active = currentTab === id ? "true" : "false";
        b.textContent = label;
        b.addEventListener("click", () => {
          currentTab = id;
          renderModal();
        });
        return b;
      };
      tabs.appendChild(mkTab("groups", "分组与排序"));
      tabs.appendChild(mkTab("plugins", "插件管理"));
      modal.appendChild(tabs);

      const body = document.createElement("div");
      body.className = "t3p-modal-body";

      if (currentTab === "groups") {
        // Toggle grouping
        const rowGroup = document.createElement("div");
        rowGroup.className = "t3p-setting-row";
        rowGroup.innerHTML =
          `<div><div>启用自定义分组折叠</div><div class="t3p-setting-desc">关闭后将以平铺模式显示全部项目，但仍保留手动拖拽排序与颜色标记。</div></div>`;
        const grpToggle = document.createElement("input");
        grpToggle.type = "checkbox";
        grpToggle.checked = state.groupingEnabled;
        grpToggle.addEventListener("change", async () => {
          await persistState({ ...state, groupingEnabled: grpToggle.checked }, false);
          scheduleSync();
        });
        rowGroup.appendChild(grpToggle);
        body.appendChild(rowGroup);

        // Toggle sync native
        const rowSync = document.createElement("div");
        rowSync.className = "t3p-setting-row";
        rowSync.innerHTML =
          `<div><div>同步 T3 原生手动排序</div><div class="t3p-setting-desc">拖拽项目后同步写入 T3 前端的 projectOrder，使命令面板顺序保持一致。</div></div>`;
        const syncToggle = document.createElement("input");
        syncToggle.type = "checkbox";
        syncToggle.checked = state.syncNativeOrder;
        syncToggle.addEventListener("change", async () => {
          await persistState({ ...state, syncNativeOrder: syncToggle.checked }, true);
          scheduleSync();
        });
        rowSync.appendChild(syncToggle);
        body.appendChild(rowSync);

        // Group list editor
        const listTitle = document.createElement("div");
        listTitle.style.fontWeight = "600";
        listTitle.textContent = "分组列表";
        body.appendChild(listTitle);

        const groupList = document.createElement("div");
        groupList.className = "t3p-group-list";

        state.groups.forEach((g, idx) => {
          const item = document.createElement("div");
          item.className = "t3p-group-item";

          const colorInput = document.createElement("input");
          colorInput.type = "color";
          colorInput.value = g.color || "#3b82f6";
          colorInput.style.width = "26px";
          colorInput.style.height = "26px";
          colorInput.style.border = "none";
          colorInput.style.background = "transparent";
          colorInput.style.cursor = "pointer";
          colorInput.addEventListener("change", async () => {
            const nextGroups = state.groups.map((it) =>
              it.id === g.id ? { ...it, color: colorInput.value } : it
            );
            await persistState({ ...state, groups: nextGroups }, false);
            scheduleSync();
          });

          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.className = "t3p-input";
          nameInput.style.flex = "1";
          nameInput.value = g.name;
          nameInput.addEventListener("change", async () => {
            const val = nameInput.value.trim() || g.name;
            const nextGroups = state.groups.map((it) =>
              it.id === g.id ? { ...it, name: val } : it
            );
            await persistState({ ...state, groups: nextGroups }, false);
            scheduleSync();
          });

          const prefixInput = document.createElement("input");
          prefixInput.type = "text";
          prefixInput.className = "t3p-input";
          prefixInput.style.width = "100px";
          prefixInput.placeholder = "自动前缀";
          prefixInput.title = "自动匹配以此文字开头的项目名";
          prefixInput.value = g.matchPrefix || "";
          prefixInput.addEventListener("change", async () => {
            const nextGroups = state.groups.map((it) =>
              it.id === g.id ? { ...it, matchPrefix: prefixInput.value.trim() } : it
            );
            await persistState({ ...state, groups: nextGroups }, false);
            scheduleSync();
          });

          const upBtn = document.createElement("button");
          upBtn.type = "button";
          upBtn.className = "t3p-btn";
          upBtn.textContent = "↑";
          upBtn.disabled = idx === 0;
          upBtn.addEventListener("click", async () => {
            if (idx === 0) return;
            const next = moveGroup(state, g.id, state.groups[idx - 1].id, "before");
            await persistState(next, true);
            scheduleSync();
            renderModal();
          });

          const downBtn = document.createElement("button");
          downBtn.type = "button";
          downBtn.className = "t3p-btn";
          downBtn.textContent = "↓";
          downBtn.disabled = idx === state.groups.length - 1;
          downBtn.addEventListener("click", async () => {
            if (idx === state.groups.length - 1) return;
            const next = moveGroup(state, g.id, state.groups[idx + 1].id, "after");
            await persistState(next, true);
            scheduleSync();
            renderModal();
          });

          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "t3p-btn t3p-btn-danger";
          delBtn.textContent = "删";
          delBtn.disabled = state.groups.length <= 1;
          delBtn.addEventListener("click", async () => {
            if (state.groups.length <= 1) return;
            const nextGroups = state.groups.filter((it) => it.id !== g.id);
            const fallbackId = nextGroups[nextGroups.length - 1].id;
            const nextProjectGroups = { ...state.projectGroups };
            for (const [rk, gid] of Object.entries(nextProjectGroups)) {
              if (gid === g.id) nextProjectGroups[rk] = fallbackId;
            }
            const nextFilter = state.filterGroupId === g.id ? "all" : state.filterGroupId;
            await persistState(
              { ...state, groups: nextGroups, projectGroups: nextProjectGroups, filterGroupId: nextFilter },
              true
            );
            scheduleSync();
            renderModal();
          });

          item.appendChild(colorInput);
          item.appendChild(nameInput);
          item.appendChild(prefixInput);
          item.appendChild(upBtn);
          item.appendChild(downBtn);
          item.appendChild(delBtn);
          groupList.appendChild(item);
        });
        body.appendChild(groupList);

        // Add new group
        const addRow = document.createElement("div");
        addRow.style.display = "flex";
        addRow.style.gap = "8px";
        addRow.style.alignItems = "center";

        const newName = document.createElement("input");
        newName.type = "text";
        newName.className = "t3p-input";
        newName.style.flex = "1";
        newName.placeholder = "新分组名称（例如：专项分析）";

        const newColor = document.createElement("input");
        newColor.type = "color";
        newColor.value = "#10b981";
        newColor.style.width = "28px";
        newColor.style.height = "28px";
        newColor.style.border = "none";
        newColor.style.background = "transparent";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "t3p-btn t3p-btn-primary";
        addBtn.textContent = "新增分组";
        addBtn.addEventListener("click", async () => {
          const label = newName.value.trim();
          if (!label) return;
          const id = `grp-${Date.now().toString(36)}`;
          const nextGroups = [
            ...state.groups,
            { id, name: label, color: newColor.value, collapsed: false, matchPrefix: "" },
          ];
          await persistState({ ...state, groups: nextGroups }, false);
          scheduleSync();
          renderModal();
        });

        addRow.appendChild(newColor);
        addRow.appendChild(newName);
        addRow.appendChild(addBtn);
        body.appendChild(addRow);

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "t3p-btn";
        resetBtn.style.alignSelf = "flex-start";
        resetBtn.textContent = "恢复默认分组与顺序（好友房 / 金币房 / 其他项目）";
        resetBtn.addEventListener("click", async () => {
          await persistState(createDefaultState(), true);
          scheduleSync();
          renderModal();
        });
        body.appendChild(resetBtn);
      } else {
        const plugins = window.T3Plugins?.getPlugins?.() || [];
        if (plugins.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = "当前没有已注册的本地插件。";
          body.appendChild(empty);
        }
        for (const p of plugins) {
          const row = document.createElement("div");
          row.className = "t3p-setting-row";
          const info = document.createElement("div");
          const t = document.createElement("div");
          t.textContent = `${p.name || p.id} (v${p.version || "1.0.0"})`;
          const d = document.createElement("div");
          d.className = "t3p-setting-desc";
          d.textContent = `ID: ${p.id}${p.runtime ? " · 已加载" : ""}`;
          info.appendChild(t);
          info.appendChild(d);

          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.checked = p.enabled !== false;
          chk.addEventListener("change", async () => {
            if (window.T3Plugins?.togglePlugin) {
              await window.T3Plugins.togglePlugin(p.id, chk.checked);
            }
          });
          row.appendChild(info);
          row.appendChild(chk);
          body.appendChild(row);
        }

        const reloadBtn = document.createElement("button");
        reloadBtn.type = "button";
        reloadBtn.className = "t3p-btn t3p-btn-primary";
        reloadBtn.style.alignSelf = "flex-start";
        reloadBtn.textContent = "重载页面（Ctrl+R）使插件启停或代码修改生效";
        reloadBtn.addEventListener("click", () => window.T3Plugins?.reload?.());
        body.appendChild(reloadBtn);
      }

      modal.appendChild(body);

      const footer = document.createElement("div");
      footer.className = "t3p-modal-footer";
      footer.textContent = "插件目录: %USERPROFILE%\\.qui\\userdata\\plugins";
      modal.appendChild(footer);
    }

    renderModal();
    document.body.appendChild(backdrop);
    activeModal = backdrop;
  }

  async function init() {
    const fallback = createDefaultState();
    if (window.T3Plugins && typeof window.T3Plugins.getState === "function") {
      state = normalizeState(await window.T3Plugins.getState(PLUGIN_ID, fallback));
    } else {
      state = fallback;
    }

    document.addEventListener("click", (e) => {
      if (activePopover && !activePopover.contains(e.target) && !e.target.closest?.("[data-t3p-color-btn]")) {
        closePopover();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closePopover();
        closeModal();
      }
    });

    const observer = new MutationObserver((mutations) => {
      if (isApplying) return;
      for (const m of mutations) {
        if (m.target && m.target.closest && (m.target.closest("[data-t3p-role]") || m.target.closest(".t3p-color-popover") || m.target.closest(".t3p-modal-backdrop"))) {
          continue;
        }
        scheduleSync();
        break;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scheduleSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
