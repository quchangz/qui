"use strict";

const SCAN_CACHE_FILE = "usage-scan-cache-v17.json";
const RATES_FILE = "usage-model-rates.json";
const T3_STATE_DB = "statev2.sqlite";
const SCAN_COVERED_PROVIDERS = new Set(["codex", "claude", "claudeagent", "claude-agent", "grok", "pi"]);

const ANTIGRAVITY_MODEL_IDS = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1401: "claude-opus-5-5-medium",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1525: "gemini-4-hydrogen",
  1526: "gemini-4-hydrogen",
  1530: "gemini-4-hydrogen-tiered-high",
  1533: "gemini-4-neon",
  1537: "gemini-pro-orchestrator-neon",
  1669: "gemini-4-hydrogen-orchestrator",
};

let cachedRates = { mtimeMs: 0, doc: null };
const antigravityDbCache = new Map();
const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

function safeParseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseIsoMs(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val !== "string" || !val) return null;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms : null;
}

function loadRatesDoc({ fs, path, os }) {
  const p = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".qui"), "userdata", RATES_FILE);
  try {
    if (!fs.existsSync(p)) return {};
    const st = fs.statSync(p);
    if (cachedRates.doc && cachedRates.mtimeMs === st.mtimeMs) {
      return cachedRates.doc;
    }
    const parsed = safeParseJson(fs.readFileSync(p, "utf8"), null);
    const doc = parsed && typeof parsed.document === "object" && parsed.document ? parsed.document : {};
    cachedRates = { mtimeMs: st.mtimeMs, doc };
    return doc;
  } catch {
    return {};
  }
}

function antigravityRateModel(model) {
  let base = String(model || "").trim();
  const suffixRe = /-(?:orchestrator|extra-low|extra-high|xhigh|low|medium|high|tiered|control|thinking|agent)$/i;
  while (suffixRe.test(base)) {
    base = base.replace(suffixRe, "");
  }
  if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/i.test(model || "")) return "gemini-3.5-flash";
  if (model === "gemini-3.7-flash-safety-le") return "gemini-3.7-flash";
  if (base === "gemini-3-flash") return "gemini-3-flash-preview";
  return base;
}

function lookupRateEntry(model, ratesDoc) {
  if (!model || !ratesDoc) return null;
  const raw = String(model).trim();
  const short = raw.includes("/") ? raw.split("/").pop() : raw;
  const agBase = antigravityRateModel(short);
  const stripped = short.replace(/-(?:neon|hydrogen|fast|thinking|latest)$/i, "");
  const candidates = [
    raw,
    short,
    agBase,
    `gemini/${agBase}`,
    `vertex_ai/${agBase}`,
    stripped,
    `gemini/${stripped}`,
    `vertex_ai/${stripped}`,
  ];
  for (const key of candidates) {
    if (key && ratesDoc[key] && typeof ratesDoc[key] === "object") {
      return { entry: ratesDoc[key], exact: true };
    }
  }
  return null;
}

function lookupContextLimit(model, ratesDoc) {
  const hit = lookupRateEntry(model, ratesDoc);
  if (hit && Number(hit.entry.max_input_tokens) > 0) {
    return Number(hit.entry.max_input_tokens);
  }
  if (hit && Number(hit.entry.max_tokens) > 0) {
    return Number(hit.entry.max_tokens);
  }
  const m = String(model || "").toLowerCase();
  if (m.includes("gemini")) return 1000000;
  if (m.includes("gpt-6") || m.includes("gpt-5") || m.includes("codex")) return 475000;
  if (m.includes("claude")) return 200000;
  if (m.includes("gpt")) return 200000;
  return 200000;
}

function estimateCostUsd(model, uncachedInput, cachedInput, cacheCreation, output, reasoning, ratesDoc) {
  const hit = lookupRateEntry(model, ratesDoc);
  let inRate;
  let cacheReadRate;
  let cacheWriteRate;
  let outRate;

  if (hit) {
    const e = hit.entry;
    inRate = Number(e.input_cost_per_token) || 0;
    cacheReadRate =
      e.cache_read_input_token_cost !== undefined
        ? Number(e.cache_read_input_token_cost) || 0
        : inRate * 0.1;
    cacheWriteRate =
      e.cache_creation_input_token_cost !== undefined
        ? Number(e.cache_creation_input_token_cost) || 0
        : inRate * 1.25;
    outRate = Number(e.output_cost_per_token) || 0;
  } else {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) {
      inRate = 3e-6;
      cacheReadRate = 3e-7;
      cacheWriteRate = 3.75e-6;
      outRate = 1.5e-5;
    } else if (m.includes("gemini")) {
      if (/flash|hydrogen|lite/i.test(m)) {
        inRate = 3e-7;
        cacheReadRate = 3e-8;
        cacheWriteRate = 3e-7;
        outRate = 2.5e-6;
      } else {
        inRate = 1.25e-6;
        cacheReadRate = 1.25e-7;
        cacheWriteRate = 1.25e-6;
        outRate = 1e-5;
      }
    } else if (m.includes("gpt") || m.includes("codex") || m.includes("sol")) {
      inRate = 2e-6;
      cacheReadRate = 2e-7;
      cacheWriteRate = 2e-6;
      outRate = 8e-6;
    } else {
      inRate = 1e-6;
      cacheReadRate = 1e-7;
      cacheWriteRate = 1e-6;
      outRate = 4e-6;
    }
  }

  return (
    Math.max(0, uncachedInput) * inRate +
    Math.max(0, cachedInput) * cacheReadRate +
    Math.max(0, cacheCreation) * cacheWriteRate +
    Math.max(0, output + reasoning) * outRate
  );
}

function decodeProtoFields(bytes) {
  let offset = 0;
  const result = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number" || length > bytes.length - offset) {
        throw new Error("Truncated protobuf field");
      }
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    let entries = result.get(number);
    if (!entries) {
      entries = [];
      result.set(number, entries);
    }
    entries.push(value);
  }
  return result;
}

function protoNumberAt(map, key) {
  const entry = map.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
}

function protoBytesAt(map, key) {
  const entry = map.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
}

function protoNested(map, key) {
  const bytes = protoBytesAt(map, key);
  return bytes === undefined ? new Map() : decodeProtoFields(bytes);
}

function protoTextAt(map, key) {
  const bytes = protoBytesAt(map, key);
  if (bytes === undefined) return "";
  try {
    return utf8FatalDecoder.decode(bytes).trim();
  } catch {
    return "";
  }
}

function protoTimestampMs(map) {
  const seconds = protoNumberAt(map, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(protoNumberAt(map, 2) / 1e6) : null;
}

function normalizeAntigravityModelName(name) {
  if (!name) return "";
  const normalized = String(name)
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }
  return normalized;
}

function isConcreteAntigravityModel(model) {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

function rememberAntigravityModel(models, id, model) {
  const prev = models.get(id);
  if (prev === undefined || prev === model) {
    models.set(id, model);
    return;
  }
  if (prev === null) return;
  const basePrev = antigravityRateModel(prev);
  const baseCur = antigravityRateModel(model);
  models.set(id, basePrev && basePrev === baseCur ? basePrev : null);
}

function decodeAntigravityMetadata(bytes, isStep) {
  const root = decodeProtoFields(bytes);
  if (!isStep && protoBytesAt(root, 1) === undefined) return null;
  const data = isStep ? root : protoNested(root, 1);
  const modelMsg = isStep ? protoNested(data, 24) : data;
  const usageBytes = protoBytesAt(data, isStep ? 9 : 4);
  const primaryUsage = usageBytes === undefined ? undefined : decodeProtoFields(usageBytes.slice());
  const usages = primaryUsage === undefined ? [] : [primaryUsage];
  for (const retry of data.get(isStep ? 28 : 17) || []) {
    if (retry instanceof Uint8Array) {
      const retryUsage = protoBytesAt(decodeProtoFields(retry), 2);
      if (retryUsage !== undefined) usages.push(decodeProtoFields(retryUsage.slice()));
    }
  }
  const names = [protoTextAt(modelMsg, isStep ? 12 : 19), protoTextAt(modelMsg, isStep ? 8 : 21)].map(
    normalizeAntigravityModelName
  );
  const resolvedModel =
    names.find(isConcreteAntigravityModel) || names.find((n) => n && !/^model[_-]/.test(n)) || "";
  return {
    model: resolvedModel,
    modelId: protoNumberAt(modelMsg, isStep ? 1 : 3) || (primaryUsage ? protoNumberAt(primaryUsage, 1) : 0),
    timestampMs: isStep
      ? protoTimestampMs(protoNested(data, 8)) ?? protoTimestampMs(protoNested(data, 1))
      : protoTimestampMs(protoNested(protoNested(data, 9), 4)),
    usages,
  };
}

function canonicalPathKey(fs, targetPath) {
  let resolved = targetPath;
  try {
    resolved = fs.realpathSync(targetPath);
  } catch {
    resolved = targetPath;
  }
  return {
    resolved,
    key: process.platform === "win32" ? resolved.toLowerCase() : resolved,
  };
}

function discoverAntigravityConversationDirs({ fs, path, os }) {
  const home = os.homedir();
  const roots = [];
  const agProviderRoots = [
    path.join(process.env.T3CODE_HOME || path.join(home, ".qui"), "userdata", "providers", "antigravity"),
    path.join(home, ".t3", "userdata", "providers", "antigravity"),
  ];
  for (const agProvidersDir of agProviderRoots) {
    try {
      if (fs.existsSync(agProvidersDir)) {
        for (const ent of fs.readdirSync(agProvidersDir, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            roots.push(path.join(agProvidersDir, ent.name, "antigravity-acp"));
          }
        }
      }
    } catch {
      // ignore
    }
  }
  for (const name of ["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"]) {
    roots.push(path.join(home, ".gemini", name));
  }
  roots.push(path.join(home, ".config", "antigravity"));

  const seenDirs = new Set();
  const dirs = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const nested = path.join(root, "conversations");
    const chosen = fs.existsSync(nested) ? nested : root;
    const { resolved, key } = canonicalPathKey(fs, chosen);
    if (!seenDirs.has(key)) {
      seenDirs.add(key);
      dirs.push(resolved);
    }
  }
  return dirs;
}

function decodeAntigravityDbFile({ sqlite }, dbPath, sessionId, fallbackTimestamp) {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    if (!tables.has("gen_metadata") && !tables.has("steps")) {
      return { candidates: [], models: [] };
    }

    const generations = [];
    if (tables.has("gen_metadata")) {
      for (const row of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all()) {
        if (!(row.data instanceof Uint8Array)) continue;
        const entry = decodeAntigravityMetadata(row.data, false);
        if (entry) generations.push({ idx: row.idx, entry });
      }
    }

    let trajectoryTimestamp = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").all()) {
        if (!(row.data instanceof Uint8Array)) continue;
        trajectoryTimestamp ??= protoTimestampMs(protoNested(decodeProtoFields(row.data), 2));
      }
    }

    const steps = [];
    if (tables.has("steps")) {
      for (const row of db.prepare("SELECT idx, metadata AS data FROM steps WHERE metadata IS NOT NULL ORDER BY idx").all()) {
        if (!(row.data instanceof Uint8Array)) continue;
        const entry = decodeAntigravityMetadata(row.data, true);
        if (entry) steps.push({ idx: row.idx, entry });
      }
    }

    const models = new Map();
    for (const { entry } of [...generations, ...steps]) {
      if (entry.modelId > 0 && isConcreteAntigravityModel(entry.model)) {
        rememberAntigravityModel(models, entry.modelId, entry.model);
      }
    }

    const generationByIdx = new Map(generations.map(({ idx, entry }) => [idx, entry]));
    const candidates = [];
    for (const [source, list] of [
      ["step", steps],
      ["generation", generations],
    ]) {
      for (let index = 0; index < list.length; index++) {
        const { idx, entry } = list[index];
        for (let usageIndex = 0; usageIndex < entry.usages.length; usageIndex++) {
          const usage = entry.usages[usageIndex];
          const modelId = protoNumberAt(usage, 1) || entry.modelId;
          const gen = source === "step" ? generationByIdx.get(idx) : undefined;
          const matches = (m) => modelId === 0 || m.modelId === modelId;
          const model =
            matches(entry) && entry.model ? entry.model : gen && matches(gen) && gen.model ? gen.model : "";
          const totalOut = Math.max(protoNumberAt(usage, 3), protoNumberAt(usage, 9) + protoNumberAt(usage, 10));
          const reasoning = Math.min(totalOut, protoNumberAt(usage, 9));
          const visibleOutput = Math.max(0, totalOut - reasoning);
          const uncachedInput = protoNumberAt(usage, 2);
          const cachedInput = protoNumberAt(usage, 5);
          const cacheCreation = protoNumberAt(usage, 4);
          if (uncachedInput + cachedInput + cacheCreation + totalOut === 0) continue;

          const idKeys = [11, 12, 7].flatMap((k) => {
            const id = protoTextAt(usage, k);
            return id ? [`antigravity:${k}:${id}`] : [];
          });
          const keys = idKeys.length > 0 ? idKeys : [`antigravity:${sessionId}:${source}:${index}:${usageIndex}`];

          candidates.push({
            model,
            modelId,
            modelQuality: isConcreteAntigravityModel(model) ? 4 : model ? 1 : 0,
            timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
            timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
            uncachedInput,
            cachedInput,
            cacheCreation,
            visibleOutput,
            reasoning,
            keys,
          });
        }
      }
    }

    return {
      candidates,
      models: Array.from(models.entries()),
    };
  } finally {
    db.close();
  }
}

function readAntigravityDbUsage({ fs, path, os, sqlite, sinceMs, untilMs, ratesDoc }, warnings = []) {
  const dirs = discoverAntigravityConversationDirs({ fs, path, os });
  const visitedFiles = new Set();
  const learnedModels = new Map();
  const decodedFiles = [];
  let scannedAnyDb = false;

  const walkDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      if (!ent.name.endsWith(".db")) continue;
      scannedAnyDb = true;
      const { resolved, key } = canonicalPathKey(fs, fullPath);
      if (visitedFiles.has(key)) continue;
      visitedFiles.add(key);

      try {
        const st = fs.statSync(resolved);
        let walPart = "-";
        let walMtimeMs = 0;
        const walPath = `${resolved}-wal`;
        if (fs.existsSync(walPath)) {
          try {
            const wst = fs.statSync(walPath);
            walPart = `${wst.size}:${wst.mtimeMs}:${wst.ctimeMs}`;
            walMtimeMs = wst.mtimeMs;
          } catch {
            // ignore wal stat failure
          }
        }
        const maxMtimeMs = Math.max(st.mtimeMs, walMtimeMs);
        if (Number.isFinite(sinceMs) && maxMtimeMs < sinceMs - 86400000) {
          continue;
        }
        const fingerprint = `${st.size}:${st.mtimeMs}:${st.ctimeMs}/${walPart}`;
        let data = antigravityDbCache.get(key)?.fingerprint === fingerprint ? antigravityDbCache.get(key).data : null;
        if (!data) {
          data = decodeAntigravityDbFile({ sqlite }, resolved, path.basename(resolved, ".db"), st.mtimeMs);
          antigravityDbCache.set(key, { fingerprint, data });
        }
        for (const [id, m] of data.models) {
          rememberAntigravityModel(learnedModels, id, m);
        }
        decodedFiles.push(data.candidates);
      } catch (err) {
        warnings.push(`readAntigravityDb(${ent.name}): ${err.message}`);
      }
    }
  };

  for (const dir of dirs) {
    walkDir(dir);
  }

  // Union-Find deduplication across steps/generations and ~/.gemini/antigravity* clones
  const groups = [];
  const identities = new Map();
  const find = (index) => {
    let root = index;
    while (groups[root].parent !== root) root = groups[root].parent;
    while (index !== root) {
      const parent = groups[index].parent;
      groups[index].parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left, right) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a].size < groups[b].size) [a, b] = [b, a];
    const target = groups[a];
    const source = groups[b];
    const first = target.owner < source.owner ? target : source;
    const bestModel =
      source.modelQuality === target.modelQuality
        ? first
        : source.modelQuality > target.modelQuality
          ? source
          : target;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality && source.timestampMs < target.timestampMs)
        ? source
        : target;

    target.model = bestModel.model;
    target.modelQuality = bestModel.modelQuality;
    target.timestampMs = bestTime.timestampMs;
    target.timestampQuality = bestTime.timestampQuality;
    target.uncachedInput = Math.max(target.uncachedInput, source.uncachedInput);
    target.cachedInput = Math.max(target.cachedInput, source.cachedInput);
    target.cacheCreation = Math.max(target.cacheCreation, source.cacheCreation);
    target.visibleOutput = Math.max(target.visibleOutput, source.visibleOutput);
    target.reasoning = Math.max(target.reasoning, source.reasoning);
    target.owner = first.owner;
    target.size += source.size;
    source.parent = a;
    return a;
  };

  for (const candidates of decodedFiles) {
    for (const c of candidates) {
      const learned = learnedModels.get(c.modelId);
      const fallback = learned === null ? undefined : ANTIGRAVITY_MODEL_IDS[c.modelId];
      const model =
        (c.modelQuality === 4 ? c.model : "") ||
        learned ||
        fallback ||
        c.model ||
        (c.modelId > 0 ? `antigravity-model-${c.modelId}` : "antigravity-unknown");
      const modelQuality = c.modelQuality === 4 ? 4 : learned ? 3 : fallback ? 2 : c.modelQuality;

      const idx = groups.length;
      groups.push({
        model,
        modelQuality,
        timestampMs: c.timestampMs,
        timestampQuality: c.timestampQuality,
        uncachedInput: c.uncachedInput,
        cachedInput: c.cachedInput,
        cacheCreation: c.cacheCreation,
        visibleOutput: c.visibleOutput,
        reasoning: c.reasoning,
        parent: idx,
        size: 1,
        owner: idx,
      });

      for (const idKey of c.keys) {
        const existing = identities.get(idKey);
        if (existing !== undefined) {
          merge(idx, existing);
        } else {
          identities.set(idKey, idx);
        }
      }
    }
  }

  const events = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.parent !== i) continue;
    const tsMs = g.timestampMs;
    if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;

    const rateModel = antigravityRateModel(g.model);
    const costUsd = estimateCostUsd(
      rateModel,
      g.uncachedInput,
      g.cachedInput,
      g.cacheCreation,
      g.visibleOutput,
      g.reasoning,
      ratesDoc
    );
    events.push({
      tsMs,
      provider: "antigravity",
      model: g.model,
      uncachedInput: g.uncachedInput,
      cachedInput: g.cachedInput,
      cacheCreation: g.cacheCreation,
      output: g.visibleOutput,
      reasoning: g.reasoning,
      costUsd,
      durationMs: null,
    });
  }

  return { events, scannedAnyDb };
}

function classifyQuotaPresentation(providerId, id, bucket, providerName, label) {
  const pid = String(providerId || "").toLowerCase();
  const wid = String(id || "").toLowerCase();
  if (pid === "codex" && (wid === "primary" || bucket === "5h")) {
    return { sortOrder: 1, displayLabel: "Codex", windowTag: "5h", group: "codex", sublabel: "" };
  }
  if (pid === "codex" && (wid === "secondary" || bucket === "weekly")) {
    return { sortOrder: 2, displayLabel: "Codex", windowTag: "Weekly", group: "codex", sublabel: "" };
  }
  if (pid === "antigravity" && wid.includes("gemini") && bucket === "5h") {
    return { sortOrder: 3, displayLabel: "Gemini", windowTag: "5h", group: "gemini", sublabel: "" };
  }
  if (pid === "antigravity" && wid.includes("gemini") && bucket === "weekly") {
    return { sortOrder: 4, displayLabel: "Gemini", windowTag: "Weekly", group: "gemini", sublabel: "" };
  }
  if (pid === "antigravity" && (wid.includes("3p") || wid.includes("claude") || wid.includes("gpt")) && bucket === "5h") {
    return { sortOrder: 5, displayLabel: "Claude & GPT", windowTag: "5h", group: "3p", sublabel: "" };
  }
  if (pid === "antigravity" && (wid.includes("3p") || wid.includes("claude") || wid.includes("gpt")) && bucket === "weekly") {
    return { sortOrder: 6, displayLabel: "Claude & GPT", windowTag: "Weekly", group: "3p", sublabel: "" };
  }
  const cleanLabel = String(label || "").replace(/\s*·\s*(5-hour|Weekly)/i, "").trim();
  return {
    sortOrder: 99,
    displayLabel: cleanLabel || providerName,
    windowTag: bucket === "5h" ? "5h" : "Weekly",
    group: pid || "other",
    sublabel: "",
  };
}

function readSubscriptionQuotas({ fs, path, os }, warnings = []) {
  const cachesDir = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".qui"), "caches");
  const session5h = [];
  const weekly = [];
  const orderedRaw = [];
  const resetCredits = [];
  const unavailable = [];
  let latestCheckedAt = null;

  try {
    if (!fs.existsSync(cachesDir)) {
      return { session5h, weekly, ordered: [], resetCredits, unavailable, checkedAt: null };
    }
    const files = fs.readdirSync(cachesDir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const fullPath = path.join(cachesDir, file);
      const data = safeParseJson(fs.readFileSync(fullPath, "utf8"), null);
      if (!data || typeof data !== "object") continue;
      if (data.enabled === false && data.status !== "ready") continue;
      const ul = data.usageLimits;
      const providerId = file.replace(/\.json$/i, "");
      const providerName = data.displayName || providerId;
      if (!ul || !Array.isArray(ul.windows) || ul.windows.length === 0) {
        if (ul && ul.unavailable && ul.unavailable.message) {
          unavailable.push({
            providerName,
            message: ul.unavailable.message,
            lastGood: null,
          });
        }
        continue;
      }
      if (ul.checkedAt && (!latestCheckedAt || ul.checkedAt > latestCheckedAt)) {
        latestCheckedAt = ul.checkedAt;
      }

      for (const w of ul.windows) {
        if (!w || typeof w !== "object") continue;
        if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
        const usedPercent = Math.max(0, Math.min(100, w.usedPercent));
        const remainingPercent = Number((100 - usedPercent).toFixed(1));
        const mins = Number(w.windowDurationMins) || 0;
        const textHint = `${w.id || ""} ${w.label || ""}`;
        const is5h =
          w.kind === "session" ||
          (mins > 0 && mins <= 1440) ||
          /5h|5-hour|session/i.test(textHint);
        const bucket = is5h ? "5h" : "weekly";
        const pres = classifyQuotaPresentation(providerId, w.id, bucket, providerName, w.label || w.id || providerName);

        const item = {
          providerId,
          providerName,
          id: w.id || w.label || providerId,
          label: w.label || w.id || providerName,
          displayLabel: pres.displayLabel,
          windowTag: pres.windowTag,
          group: pres.group,
          sublabel: pres.sublabel,
          sortOrder: pres.sortOrder,
          bucket,
          usedPercent: Number(usedPercent.toFixed(1)),
          remainingPercent,
          exhausted: usedPercent === 100,
          checkedAt: ul.checkedAt || null,
          resetsAt: w.resetsAt || null,
          windowDurationMins: mins || null,
        };
        orderedRaw.push(item);
        if (is5h) {
          session5h.push(item);
        } else {
          weekly.push(item);
        }
      }

      if (ul.resetCredits && typeof ul.resetCredits === "object") {
        resetCredits.push({
          providerId,
          providerName,
          availableCount: Number(ul.resetCredits.availableCount) || 0,
          nextExpiresAt: ul.resetCredits.nextExpiresAt || null,
        });
      }
    }
  } catch (err) {
    warnings.push(`readSubscriptionQuotas: ${err.message}`);
  }

  const ordered = orderedRaw
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.idx - b.idx)
    .map(({ item }) => item);

  return { session5h, weekly, ordered, resetCredits, unavailable, checkedAt: latestCheckedAt };
}

function hermesDbPath({ path, os }) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "hermes", "state.db");
}

function queryHermesSession({ fs, path, os, sqlite, sessionId }, warnings = []) {
  if (!sessionId) return null;
  const dbPath = hermesDbPath({ path, os });
  if (!fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT id, model, started_at, last_activity_at, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, api_call_count
         FROM sessions WHERE id = ? LIMIT 1`
      )
      .get(sessionId);
    return row || null;
  } catch (err) {
    warnings.push(`queryHermesSession: ${err.message}`);
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

const CONTEXT_CATEGORIES = {
  assistant_message: { key: "assistant_message", label: "模型回复", color: "#2563eb" },
  command_execution: { key: "command_execution", label: "工具结果", color: "#0d9488" },
  reasoning: { key: "reasoning", label: "思考推理", color: "#8b5cf6" },
  file_change: { key: "file_change", label: "文件变更", color: "#f97316" },
  mcp_tool: { key: "mcp_tool", label: "MCP 工具", color: "#ec4899" },
  system_tool: { key: "system_tool", label: "系统工具", color: "#ea580c" },
  handoff: { key: "handoff", label: "压缩摘要", color: "#eab308" },
  search_notify: { key: "search_notify", label: "搜索与通知", color: "#16a34a" },
  user_message: { key: "user_message", label: "用户消息", color: "#6366f1" },
  system_prompt: { key: "system_prompt", label: "系统提示词", color: "#64748b" },
};

function estimateTextTokens(val) {
  if (val === null || val === undefined) return 0;
  let str = "";
  if (typeof val === "string") {
    str = val;
  } else if (typeof val === "object") {
    try {
      str = JSON.stringify(val);
    } catch {
      str = "";
    }
  } else {
    str = String(val);
  }
  if (!str) return 0;
  if (str.length > 200000) str = str.slice(0, 200000);
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  const other = str.length - cjk;
  return Math.round(cjk * 1.3 + other / 3.8);
}

function computeContextBreakdown(itemRows) {
  if (!Array.isArray(itemRows) || itemRows.length === 0) {
    return { items: [], totalEstimatedTokens: 0 };
  }
  let startIdx = 0;
  for (let i = itemRows.length - 1; i >= 0; i--) {
    if (itemRows[i] && itemRows[i].type === "handoff") {
      startIdx = i;
      break;
    }
  }

  const sums = new Map();
  const add = (catKey, tok) => {
    if (!tok || tok <= 0) return;
    sums.set(catKey, (sums.get(catKey) || 0) + tok);
  };

  for (let i = startIdx; i < itemRows.length; i++) {
    const row = itemRows[i];
    if (!row || !row.payload_json) continue;
    const p = safeParseJson(row.payload_json, null);
    if (!p || typeof p !== "object") continue;

    switch (row.type) {
      case "assistant_message":
        add("assistant_message", estimateTextTokens(p.text));
        break;
      case "command_execution":
        add(
          "command_execution",
          estimateTextTokens(p.input) + estimateTextTokens(p.output) + estimateTextTokens(p.title)
        );
        break;
      case "reasoning":
        add("reasoning", estimateTextTokens(p.text));
        break;
      case "file_change":
        add(
          "file_change",
          estimateTextTokens(p.fileName) + estimateTextTokens(p.diffStr) + estimateTextTokens(p.title)
        );
        break;
      case "dynamic_tool": {
        const toolName = String(p.toolName || "");
        const isMcp = /^(mcp_|t3_|preview_|delegate|thread_|issue|pull_request|device_)/i.test(toolName);
        add(
          isMcp ? "mcp_tool" : "system_tool",
          estimateTextTokens(toolName) + estimateTextTokens(p.input) + estimateTextTokens(p.output)
        );
        break;
      }
      case "handoff":
        add("handoff", estimateTextTokens(p.summary) + estimateTextTokens(p.title));
        break;
      case "web_search":
      case "file_search":
      case "notification":
        add(
          "search_notify",
          estimateTextTokens(p.patterns) +
            estimateTextTokens(p.pattern) +
            estimateTextTokens(p.results) +
            estimateTextTokens(p.summary) +
            estimateTextTokens(p.title)
        );
        break;
      case "user_message":
        add("user_message", estimateTextTokens(p.text) + estimateTextTokens(p.context));
        break;
      default:
        break;
    }
  }

  let totalEstimatedTokens = 0;
  const items = [];
  for (const [key, tokens] of sums.entries()) {
    if (tokens <= 0) continue;
    const meta = CONTEXT_CATEGORIES[key] || { key, label: key, color: "#64748b" };
    items.push({ key: meta.key, label: meta.label, color: meta.color, tokens: Math.round(tokens) });
    totalEstimatedTokens += Math.round(tokens);
  }
  items.sort((a, b) => b.tokens - a.tokens);
  return { items, totalEstimatedTokens };
}

function finalizeExactBreakdown(rawBreakdown, usedTokens) {
  const used = Math.max(0, Math.round(Number(usedTokens) || 0));
  if (used <= 0) return [];
  const { items, totalEstimatedTokens } = rawBreakdown;
  if (!items || items.length === 0 || totalEstimatedTokens <= 0) {
    return [{ ...CONTEXT_CATEGORIES.system_prompt, tokens: used }];
  }
  if (totalEstimatedTokens < used) {
    const out = items.map((x) => ({ ...x }));
    out.push({ ...CONTEXT_CATEGORIES.system_prompt, tokens: used - totalEstimatedTokens });
    out.sort((a, b) => b.tokens - a.tokens);
    return out;
  }
  const scale = used / totalEstimatedTokens;
  return items
    .map((x) => ({ ...x, tokens: Math.max(1, Math.round(x.tokens * scale)) }))
    .filter((x) => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

const threadFirstTextCache = new Map();

function readFirstTextByTurn(db, threadId) {
  if (!threadId) return new Map();
  let entry = threadFirstTextCache.get(threadId);
  if (!entry) {
    entry = { lastSeq: 0, firstTextByTurn: new Map() };
    if (threadFirstTextCache.size >= 40) {
      const oldestKey = threadFirstTextCache.keys().next().value;
      if (oldestKey !== undefined) threadFirstTextCache.delete(oldestKey);
    }
    threadFirstTextCache.set(threadId, entry);
  }
  try {
    const rows = db
      .prepare(
        `SELECT sequence, occurred_at,
                json_extract(payload_json, '$.providerTurnId') AS turn_id,
                json_extract(payload_json, '$.text') AS text,
                json_extract(payload_json, '$.streaming') AS streaming,
                json_extract(payload_json, '$.phase') AS phase
         FROM orchestration_events
         WHERE aggregate_kind = 'thread'
           AND stream_id = ?
           AND sequence > ?
           AND event_type = 'turn-item.updated'
           AND json_extract(payload_json, '$.type') = 'assistant_message'
         ORDER BY sequence ASC`
      )
      .all(threadId, entry.lastSeq);
    for (const row of rows) {
      entry.lastSeq = row.sequence;
      if (!row.turn_id || typeof row.text !== "string" || !row.text.trim()) continue;
      const ts = parseIsoMs(row.occurred_at);
      if (ts === null) continue;
      let first = entry.firstTextByTurn.get(row.turn_id);
      if (!first) {
        first = { visibleMs: ts, responseMs: null };
        entry.firstTextByTurn.set(row.turn_id, first);
      }
      first.visibleMs = Math.min(first.visibleMs, ts);
      if (row.streaming === 1 || row.phase === "commentary") {
        first.responseMs = Math.min(first.responseMs ?? ts, ts);
      }
    }
  } catch {
    // Older databases may lack the event stream.
  }
  return entry.firstTextByTurn;
}

function readThreadMetrics({ fs, path, os, sqlite, threadId, ratesDoc }, warnings = []) {
  const dbPath = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".qui"), "userdata", T3_STATE_DB);
  if (!fs.existsSync(dbPath)) {
    return { threadId: threadId || null, empty: true, context: null, speed: null, turns: [] };
  }

  let db = null;
  let threadRow = null;
  let turnRows = [];
  let itemRows = [];
  let firstTextByTurn = new Map();

  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    if (threadId) {
      threadRow = db
        .prepare(
          `SELECT thread_id, title, default_provider, provider_instance_id, updated_at, payload_json
           FROM orchestration_v2_projection_threads WHERE thread_id = ? LIMIT 1`
        )
        .get(threadId);
    }
    if (!threadRow) {
      threadRow = db
        .prepare(
          `SELECT thread_id, title, default_provider, provider_instance_id, updated_at, payload_json
           FROM orchestration_v2_projection_threads
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get();
    }
    if (!threadRow) {
      return { threadId: null, empty: true, context: null, speed: null, turns: [] };
    }

    const activeThreadId = threadRow.thread_id;
    turnRows = db
      .prepare(
        `SELECT r.run_id, r.ordinal AS run_ordinal, r.provider, r.provider_instance_id, r.requested_at,
                r.completed_at AS run_completed_at, r.payload_json AS run_payload,
                pt.provider_turn_id, pt.ordinal AS turn_ordinal, pt.status, pt.started_at, pt.completed_at,
                pt.payload_json AS turn_payload
         FROM orchestration_v2_projection_provider_turns pt
         JOIN orchestration_v2_projection_run_attempts ra ON ra.attempt_id = pt.run_attempt_id
         JOIN orchestration_v2_projection_runs r ON r.run_id = ra.run_id
         WHERE pt.thread_id = ?
         ORDER BY r.ordinal ASC, pt.ordinal ASC`
      )
      .all(activeThreadId);

    itemRows = db
      .prepare(
        `SELECT run_id, type, status, updated_at, payload_json
         FROM orchestration_v2_projection_turn_items
         WHERE thread_id = ?
         ORDER BY rowid ASC`
      )
      .all(activeThreadId);

    firstTextByTurn = readFirstTextByTurn(db, activeThreadId);
  } catch (err) {
    warnings.push(`readThreadMetrics: ${err.message}`);
    return { threadId: threadId || null, empty: true, context: null, speed: null, turns: [] };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }

  const toolCountByRun = new Map();
  for (const item of itemRows) {
    if (item.type === "command_execution" || item.type === "tool_call" || item.type === "mcp_tool_call") {
      toolCountByRun.set(item.run_id, (toolCountByRun.get(item.run_id) || 0) + 1);
    }
  }

  let hermesNativeId = null;
  const turns = [];
  let sumOutputWithTiming = 0;
  let sumDurationSec = 0;
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalReasoning = 0;

  for (const row of turnRows) {
    const turnJson = safeParseJson(row.turn_payload, {}) || {};
    const runJson = safeParseJson(row.run_payload, {}) || {};
    const tu = turnJson.tokenUsage || null;
    const ttu = turnJson.turnTokenUsage || null;

    if (!hermesNativeId && turnJson.nativeTurnRef && typeof turnJson.nativeTurnRef.nativeId === "string") {
      const prefix = turnJson.nativeTurnRef.nativeId.split(":")[0];
      if (prefix && prefix.startsWith("local-")) {
        hermesNativeId = prefix;
      }
    }

    const model =
      turnJson.model ||
      (Array.isArray(ttu?.models) && ttu.models[0]) ||
      runJson.modelSelection?.model ||
      "";
    const provider = row.provider_instance_id || row.provider || threadRow.provider_instance_id || threadRow.default_provider || "";

    const inputTokens = Number(ttu?.inputTokens ?? tu?.inputTokens ?? 0) || 0;
    const cachedInputTokens = Number(ttu?.cachedInputTokens ?? tu?.cachedInputTokens ?? 0) || 0;
    const cacheCreationTokens = Number(ttu?.cacheCreationTokens ?? 0) || 0;
    const outputTokens = Number(ttu?.outputTokens ?? tu?.outputTokens ?? 0) || 0;
    const reasoningTokens = Number(ttu?.reasoningTokens ?? tu?.reasoningOutputTokens ?? 0) || 0;

    totalInput += inputTokens;
    totalCached += cachedInputTokens;
    totalOutput += outputTokens;
    totalReasoning += reasoningTokens;

    const reqMs = parseIsoMs(row.requested_at);
    const startMs = parseIsoMs(row.started_at) ?? reqMs;
    const endMs = parseIsoMs(row.completed_at) ?? parseIsoMs(row.run_completed_at);
    const durationMs = startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;

    const firstText = firstTextByTurn.get(row.provider_turn_id);
    // Failed turns can be emitted as one-shot assistant messages containing only a provider error.
    const firstTextMs = row.status === "completed" ? firstText?.visibleMs : firstText?.responseMs;
    const ttftMs = firstTextMs != null && reqMs !== null && firstTextMs >= reqMs
      ? firstTextMs - reqMs
      : null;

    const outAll = outputTokens + reasoningTokens;
    const tokPerSec = durationMs && durationMs > 0 && outAll > 0 ? outAll / (durationMs / 1000) : null;
    if (tokPerSec !== null && row.status === "completed") {
      sumOutputWithTiming += outAll;
      sumDurationSec += durationMs / 1000;
    }

    turns.push({
      runId: row.run_id,
      ordinal: row.run_ordinal,
      provider,
      model,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs,
      ttftMs,
      toolCount: toolCountByRun.get(row.run_id) || 0,
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens,
      tokPerSec: tokPerSec !== null ? Number(tokPerSec.toFixed(1)) : null,
      usedTokens: tu?.usedTokens ?? null,
      maxTokens: tu?.maxTokens ?? null,
      usageStatus: ttu?.usageStatus || (tu ? "complete" : "unavailable"),
    });
  }

  const threadPayload = safeParseJson(threadRow.payload_json, {}) || {};
  const activeModel =
    (turns.length > 0 ? turns[turns.length - 1].model : null) ||
    threadPayload.modelSelection?.model ||
    "";
  const activeProvider =
    threadRow.provider_instance_id ||
    threadRow.default_provider ||
    (turns.length > 0 ? turns[turns.length - 1].provider : "") ||
    "";

  let hermesSession = null;
  if (activeProvider.includes("hermes") && hermesNativeId) {
    hermesSession = queryHermesSession({ fs, path, os, sqlite, sessionId: hermesNativeId }, warnings);
  }

  // Context window summary + composition breakdown
  const rawBreakdown = computeContextBreakdown(itemRows);
  const latestCompleted = [...turns].reverse().find((t) => t.status === "completed") || turns[turns.length - 1] || null;
  let context = null;
  if (latestCompleted && latestCompleted.usedTokens != null && latestCompleted.maxTokens > 0) {
    const used = Number(latestCompleted.usedTokens) || 0;
    const max = Number(latestCompleted.maxTokens);
    const cacheDenom = latestCompleted.inputTokens;
    context = {
      mode: "exact",
      model: latestCompleted.model || activeModel,
      usedTokens: used,
      maxTokens: max,
      usedPercent: Number(Math.min(100, (used / max) * 100).toFixed(1)),
      windowUsedTokens: used,
      windowUsedPercent: Number(Math.min(100, (used / max) * 100).toFixed(1)),
      windowEstimated: false,
      breakdown: finalizeExactBreakdown(rawBreakdown, used),
      inputTokens: totalInput,
      cachedInputTokens: totalCached,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      cacheHitRate: cacheDenom > 0 ? Number(((latestCompleted.cachedInputTokens / cacheDenom) * 100).toFixed(1)) : 0,
    };
  } else if (hermesSession && (hermesSession.input_tokens > 0 || hermesSession.cache_read_tokens > 0)) {
    const hIn = Number(hermesSession.input_tokens) || 0;
    const hCached = Number(hermesSession.cache_read_tokens) || 0;
    const hOut = Number(hermesSession.output_tokens) || 0;
    const hReas = Number(hermesSession.reasoning_tokens) || 0;
    const hTotalIn = hIn + hCached + (Number(hermesSession.cache_write_tokens) || 0);
    const max = lookupContextLimit(hermesSession.model || activeModel, ratesDoc);
    const winUsed = rawBreakdown.totalEstimatedTokens > 0 ? rawBreakdown.totalEstimatedTokens : Math.min(max, hTotalIn);
    const breakdown =
      rawBreakdown.items.length > 0
        ? rawBreakdown.items
        : winUsed > 0
          ? [{ ...CONTEXT_CATEGORIES.system_prompt, tokens: winUsed }]
          : [];
    context = {
      mode: "hermes_session",
      model: hermesSession.model || activeModel,
      usedTokens: hTotalIn,
      maxTokens: max,
      usedPercent: null,
      windowUsedTokens: winUsed,
      windowUsedPercent: max > 0 ? Number(Math.min(100, (winUsed / max) * 100).toFixed(1)) : null,
      windowEstimated: true,
      breakdown,
      inputTokens: hTotalIn,
      cachedInputTokens: hCached,
      outputTokens: hOut,
      reasoningTokens: hReas,
      apiCallCount: Number(hermesSession.api_call_count) || 0,
      cacheHitRate: hTotalIn > 0 ? Number(((hCached / hTotalIn) * 100).toFixed(1)) : 0,
    };
  } else if (latestCompleted && (totalInput > 0 || totalOutput > 0)) {
    const max = lookupContextLimit(latestCompleted.model || activeModel, ratesDoc);
    const winUsed =
      rawBreakdown.totalEstimatedTokens > 0
        ? rawBreakdown.totalEstimatedTokens
        : Math.min(max, Number(latestCompleted.inputTokens) || 0);
    const breakdown =
      rawBreakdown.items.length > 0
        ? rawBreakdown.items
        : winUsed > 0
          ? [{ ...CONTEXT_CATEGORIES.system_prompt, tokens: winUsed }]
          : [];
    context = {
      mode: "turn_total",
      model: latestCompleted.model || activeModel,
      usedTokens: latestCompleted.inputTokens,
      maxTokens: max,
      usedPercent: null,
      windowUsedTokens: winUsed,
      windowUsedPercent: max > 0 ? Number(Math.min(100, (winUsed / max) * 100).toFixed(1)) : null,
      windowEstimated: true,
      breakdown,
      inputTokens: totalInput,
      cachedInputTokens: totalCached,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      cacheHitRate: totalInput > 0 ? Number(((totalCached / totalInput) * 100).toFixed(1)) : 0,
    };
  } else if (rawBreakdown.totalEstimatedTokens > 0) {
    const max = lookupContextLimit(activeModel, ratesDoc);
    const winUsed = rawBreakdown.totalEstimatedTokens;
    context = {
      mode: "items_estimated",
      model: activeModel,
      usedTokens: winUsed,
      maxTokens: max,
      usedPercent: null,
      windowUsedTokens: winUsed,
      windowUsedPercent: max > 0 ? Number(Math.min(100, (winUsed / max) * 100).toFixed(1)) : null,
      windowEstimated: true,
      breakdown: rawBreakdown.items,
      inputTokens: totalInput,
      cachedInputTokens: totalCached,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      cacheHitRate: totalInput > 0 ? Number(((totalCached / totalInput) * 100).toFixed(1)) : 0,
    };
  }

  const lastWithSpeed = [...turns].reverse().find((t) => t.tokPerSec !== null) || null;
  const avgTokPerSec = sumDurationSec > 0 ? Number((sumOutputWithTiming / sumDurationSec).toFixed(1)) : null;

  return {
    threadId: threadRow.thread_id,
    title: threadRow.title || "",
    provider: activeProvider,
    model: activeModel,
    empty: false,
    context,
    speed: {
      latestRunId: latestCompleted?.runId ?? null,
      lastTurnTokPerSec: lastWithSpeed ? lastWithSpeed.tokPerSec : null,
      avgTokPerSec,
      lastDurationMs: latestCompleted ? latestCompleted.durationMs : null,
      completedTurns: turns.filter((t) => t.status === "completed").length,
      totalTurns: turns.length,
    },
    turns: turns.slice(-30).reverse(),
  };
}

function getRangeWindowMs(range) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  if (range === "7d") {
    return { sinceMs: startOfToday - 6 * 86400000, untilMs: now.getTime(), days: 7 };
  }
  if (range === "30d") {
    return { sinceMs: startOfToday - 29 * 86400000, untilMs: now.getTime(), days: 30 };
  }
  return { sinceMs: startOfToday, untilMs: now.getTime(), days: 1 };
}

function formatDayKey(tsMs) {
  const d = new Date(tsMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatShortDay(dayKey) {
  const parts = dayKey.split("-");
  return `${parts[1]}/${parts[2]}`;
}

function readGlobalUsage({ fs, path, os, sqlite, range = "1d", ratesDoc }, warnings = []) {
  const { sinceMs, untilMs, days } = getRangeWindowMs(range);
  const events = [];
  const seenKeys = new Set();

  // 1. usage-scan-cache-v17.json (Codex / Claude / Grok / Pi)
  try {
    const cachePath = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".qui"), "userdata", SCAN_CACHE_FILE);
    if (fs.existsSync(cachePath)) {
      const scan = safeParseJson(fs.readFileSync(cachePath, "utf8"), null);
      if (scan && scan.files && Array.isArray(scan.models)) {
        for (const entry of Object.values(scan.files)) {
          if (!entry || !Array.isArray(entry.r)) continue;
          const provider = String(entry.p || "unknown");
          for (const rec of entry.r) {
            if (!Array.isArray(rec)) continue;
            const tsMs = Number(rec[0]);
            if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;
            const dedupeKey = typeof rec[8] === "string" && rec[8] ? rec[8] : null;
            if (dedupeKey) {
              if (seenKeys.has(dedupeKey)) continue;
              seenKeys.add(dedupeKey);
            }
            const model = scan.models[rec[1]] || "unknown";
            const rateModel = rec[11] != null ? scan.models[rec[11]] || model : model;
            const uncachedInput = Number(rec[3]) || 0;
            const cachedInput = Number(rec[4]) || 0;
            const cacheCreation = Number(rec[5]) || 0;
            const output = Number(rec[6]) || 0;
            const reasoning = Number(rec[7]) || 0;
            const reportedCost = rec[9] != null && Number.isFinite(Number(rec[9])) ? Number(rec[9]) : null;
            const costUsd =
              reportedCost !== null
                ? reportedCost
                : estimateCostUsd(rateModel, uncachedInput, cachedInput, cacheCreation, output, reasoning, ratesDoc);

            events.push({
              tsMs,
              provider,
              model,
              uncachedInput,
              cachedInput,
              cacheCreation,
              output,
              reasoning,
              costUsd,
              durationMs: null,
            });
          }
        }
      }
    }
  } catch (err) {
    warnings.push(`readGlobalUsage.scanCache: ${err.message}`);
  }

  // 1b. Antigravity conversations/*.db protobuf breakdown (per sub-model across planner & worker)
  let agScan = { events: [], scannedAnyDb: false };
  try {
    agScan = readAntigravityDbUsage({ fs, path, os, sqlite, sinceMs, untilMs, ratesDoc }, warnings);
    for (const ev of agScan.events) {
      events.push(ev);
    }
  } catch (err) {
    warnings.push(`readGlobalUsage.antigravityDb: ${err.message}`);
  }

  // 2. statev2.sqlite (speed stats for all completed turns + fallback when DB scan unavailable)
  const speedMap = new Map(); // provider|model -> { out, sec }
  let globalOutWithTiming = 0;
  let globalSecWithTiming = 0;
  try {
    const dbPath = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".qui"), "userdata", T3_STATE_DB);
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT r.provider, r.provider_instance_id, r.payload_json AS run_payload,
                    pt.started_at, pt.completed_at, pt.payload_json AS turn_payload
             FROM orchestration_v2_projection_provider_turns pt
             JOIN orchestration_v2_projection_run_attempts ra ON ra.attempt_id = pt.run_attempt_id
             JOIN orchestration_v2_projection_runs r ON r.run_id = ra.run_id
             WHERE pt.status = 'completed'`
          )
          .all();

        for (const row of rows) {
          const turnJson = safeParseJson(row.turn_payload, {}) || {};
          const runJson = safeParseJson(row.run_payload, {}) || {};
          const ttu = turnJson.turnTokenUsage || null;
          const tu = turnJson.tokenUsage || null;

          const startMs = parseIsoMs(row.started_at);
          const endMs = parseIsoMs(row.completed_at);
          const tsMs = endMs ?? startMs;
          if (tsMs === null || tsMs < sinceMs || tsMs > untilMs) continue;

          const provider = String(row.provider_instance_id || row.provider || "unknown");
          const model =
            turnJson.model ||
            (Array.isArray(ttu?.models) && ttu.models[0]) ||
            runJson.modelSelection?.model ||
            "unknown";

          const inputTotal = Number(ttu?.inputTokens ?? tu?.inputTokens ?? 0) || 0;
          const cachedInput = Number(ttu?.cachedInputTokens ?? tu?.cachedInputTokens ?? 0) || 0;
          const cacheCreation = Number(ttu?.cacheCreationTokens ?? 0) || 0;
          const uncachedInput = Math.max(0, inputTotal - cachedInput - cacheCreation);
          const output = Number(ttu?.outputTokens ?? tu?.outputTokens ?? 0) || 0;
          const reasoning = Number(ttu?.reasoningTokens ?? tu?.reasoningOutputTokens ?? 0) || 0;
          const durationMs = startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;

          if (durationMs && durationMs > 0 && output + reasoning > 0) {
            const sec = durationMs / 1000;
            globalOutWithTiming += output + reasoning;
            globalSecWithTiming += sec;
            const sk = `${provider}\0${model}`;
            const cur = speedMap.get(sk) || { out: 0, sec: 0 };
            cur.out += output + reasoning;
            cur.sec += sec;
            speedMap.set(sk, cur);
          }

          if (
            SCAN_COVERED_PROVIDERS.has(provider.toLowerCase()) ||
            (agScan.scannedAnyDb && provider.toLowerCase().includes("antigravity"))
          ) {
            continue;
          }
          if (inputTotal + output + reasoning === 0) continue;

          const costUsd = estimateCostUsd(model, uncachedInput, cachedInput, cacheCreation, output, reasoning, ratesDoc);
          events.push({
            tsMs,
            provider,
            model,
            uncachedInput,
            cachedInput,
            cacheCreation,
            output,
            reasoning,
            costUsd,
            durationMs,
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    warnings.push(`readGlobalUsage.sqlite: ${err.message}`);
  }

  // 3. Hermes state.db (local Hermes sessions)
  try {
    const hPath = hermesDbPath({ path, os });
    if (fs.existsSync(hPath)) {
      const hdb = new sqlite.DatabaseSync(hPath, { readOnly: true });
      try {
        const rows = hdb
          .prepare(
            `SELECT id, model, last_activity_at, started_at, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd
             FROM sessions
             WHERE (COALESCE(last_activity_at, started_at) * 1000) >= ?
               AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0)) > 0`
          )
          .all(sinceMs);

        for (const r of rows) {
          const tsMs = Math.round((Number(r.last_activity_at || r.started_at) || 0) * 1000);
          if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;
          const model = r.model || "hermes-auto";
          const uncachedInput = Number(r.input_tokens) || 0;
          const cachedInput = Number(r.cache_read_tokens) || 0;
          const cacheCreation = Number(r.cache_write_tokens) || 0;
          const output = Number(r.output_tokens) || 0;
          const reasoning = Number(r.reasoning_tokens) || 0;
          const reportedCost = Number(r.estimated_cost_usd) > 0 ? Number(r.estimated_cost_usd) : null;
          const costUsd =
            reportedCost !== null
              ? reportedCost
              : estimateCostUsd(model, uncachedInput, cachedInput, cacheCreation, output, reasoning, ratesDoc);

          events.push({
            tsMs,
            provider: "hermes-local",
            model,
            uncachedInput,
            cachedInput,
            cacheCreation,
            output,
            reasoning,
            costUsd,
            durationMs: null,
          });
        }
      } finally {
        hdb.close();
      }
    }
  } catch (err) {
    warnings.push(`readGlobalUsage.hermes: ${err.message}`);
  }

  // Totals & provider/model breakdown
  let totalUncached = 0;
  let totalCached = 0;
  let totalCacheCreate = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalCost = 0;
  const pmMap = new Map();

  for (const ev of events) {
    const evTokens = ev.uncachedInput + ev.cachedInput + ev.cacheCreation + ev.output + ev.reasoning;
    totalUncached += ev.uncachedInput;
    totalCached += ev.cachedInput;
    totalCacheCreate += ev.cacheCreation;
    totalOutput += ev.output;
    totalReasoning += ev.reasoning;
    totalCost += ev.costUsd;

    const k = `${ev.provider}\0${ev.model}`;
    const cur = pmMap.get(k) || {
      provider: ev.provider,
      model: ev.model,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      events: 0,
    };
    cur.totalTokens += evTokens;
    cur.inputTokens += ev.uncachedInput + ev.cachedInput + ev.cacheCreation;
    cur.cachedInputTokens += ev.cachedInput;
    cur.outputTokens += ev.output;
    cur.reasoningTokens += ev.reasoning;
    cur.costUsd += ev.costUsd;
    cur.events += 1;
    pmMap.set(k, cur);
  }

  const byProviderModel = Array.from(pmMap.values())
    .map((item) => {
      const sp = speedMap.get(`${item.provider}\0${item.model}`);
      return {
        ...item,
        costUsd: Number(item.costUsd.toFixed(4)),
        avgTokPerSec: sp && sp.sec > 0 ? Number((sp.out / sp.sec).toFixed(1)) : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // Build Line Chart series + Heatmap matrix
  const series = [];
  let heatmap;

  if (range === "1d") {
    const buckets = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, "0");
      return {
        key: hh,
        label: `${hh}时`,
        fullLabel: `今日 ${hh}:00–${hh}:59`,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        events: 0,
      };
    });
    for (const ev of events) {
      const h = new Date(ev.tsMs).getHours();
      const b = buckets[h];
      if (!b) continue;
      const evIn = ev.uncachedInput + ev.cachedInput + ev.cacheCreation;
      b.inputTokens += evIn;
      b.cachedInputTokens += ev.cachedInput;
      b.totalTokens += evIn + ev.output + ev.reasoning;
      b.outputTokens += ev.output + ev.reasoning;
      b.costUsd += ev.costUsd;
      b.events += 1;
    }
    const maxTok = Math.max(1, ...buckets.map((b) => b.totalTokens));
    for (const b of buckets) {
      series.push({
        label: b.label,
        fullLabel: b.fullLabel,
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        outputTokens: b.outputTokens,
        costUsd: Number(b.costUsd.toFixed(4)),
        events: b.events,
      });
    }
    heatmap = {
      mode: "1d",
      cols: 6,
      rows: 4,
      colLabels: ["+0h", "+1h", "+2h", "+3h", "+4h", "+5h"],
      rowLabels: ["00-05", "06-11", "12-17", "18-23"],
      cells: buckets.map((b) => ({
        label: b.fullLabel,
        shortTag: b.key,
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        costUsd: Number(b.costUsd.toFixed(4)),
        events: b.events,
        level: b.totalTokens === 0 ? 0 : Math.min(4, Math.ceil((b.totalTokens / maxTok) * 4)),
      })),
    };
  } else if (range === "7d") {
    const dayKeys = [];
    const dayIdxMap = new Map();
    const startDate = new Date(sinceMs);
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const dk = formatDayKey(d.getTime());
      dayKeys.push(dk);
      dayIdxMap.set(dk, i);
    }

    const dailyBuckets = dayKeys.map((dk) => ({
      label: formatShortDay(dk),
      fullLabel: dk,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      events: 0,
    }));
    // 6 rows (4h slots) x 7 cols (days) = 42 cells
    const grid = Array.from({ length: 6 * 7 }, (_, idx) => {
      const r = Math.floor(idx / 7);
      const c = idx % 7;
      const hStart = String(r * 4).padStart(2, "0");
      const hEnd = String((r + 1) * 4).padStart(2, "0");
      return {
        label: `${formatShortDay(dayKeys[c])} ${hStart}:00–${hEnd}:00`,
        shortTag: "",
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        events: 0,
      };
    });

    for (const ev of events) {
      const dk = formatDayKey(ev.tsMs);
      const c = dayIdxMap.get(dk);
      if (c === undefined) continue;
      const evIn = ev.uncachedInput + ev.cachedInput + ev.cacheCreation;
      const evOut = ev.output + ev.reasoning;
      const tot = evIn + evOut;
      dailyBuckets[c].inputTokens += evIn;
      dailyBuckets[c].cachedInputTokens += ev.cachedInput;
      dailyBuckets[c].totalTokens += tot;
      dailyBuckets[c].outputTokens += evOut;
      dailyBuckets[c].costUsd += ev.costUsd;
      dailyBuckets[c].events += 1;

      const slot = Math.min(5, Math.floor(new Date(ev.tsMs).getHours() / 4));
      const cell = grid[slot * 7 + c];
      cell.inputTokens += evIn;
      cell.outputTokens += evOut;
      cell.totalTokens += tot;
      cell.costUsd += ev.costUsd;
      cell.events += 1;
    }

    for (const b of dailyBuckets) {
      series.push({
        label: b.label,
        fullLabel: b.fullLabel,
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        outputTokens: b.outputTokens,
        costUsd: Number(b.costUsd.toFixed(4)),
        events: b.events,
      });
    }
    const maxCell = Math.max(1, ...grid.map((c) => c.totalTokens));
    heatmap = {
      mode: "7d",
      cols: 7,
      rows: 6,
      colLabels: dayKeys.map(formatShortDay),
      rowLabels: ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"],
      cells: grid.map((c) => ({
        label: c.label,
        shortTag: c.shortTag,
        totalTokens: c.totalTokens,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        costUsd: Number(c.costUsd.toFixed(4)),
        events: c.events,
        level: c.totalTokens === 0 ? 0 : Math.min(4, Math.ceil((c.totalTokens / maxCell) * 4)),
      })),
    };
  } else {
    const dayKeys = [];
    const dayIdxMap = new Map();
    const startDate = new Date(sinceMs);
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const dk = formatDayKey(d.getTime());
      dayKeys.push({ key: dk, date: d });
      dayIdxMap.set(dk, i);
    }
    const dailyBuckets = dayKeys.map(({ key }) => ({
      key,
      label: formatShortDay(key),
      fullLabel: key,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      events: 0,
    }));

    for (const ev of events) {
      const dk = formatDayKey(ev.tsMs);
      const idx = dayIdxMap.get(dk);
      if (idx === undefined) continue;
      const evIn = ev.uncachedInput + ev.cachedInput + ev.cacheCreation;
      const evOut = ev.output + ev.reasoning;
      const tot = evIn + evOut;
      dailyBuckets[idx].inputTokens += evIn;
      dailyBuckets[idx].cachedInputTokens += ev.cachedInput;
      dailyBuckets[idx].totalTokens += tot;
      dailyBuckets[idx].outputTokens += evOut;
      dailyBuckets[idx].costUsd += ev.costUsd;
      dailyBuckets[idx].events += 1;
    }

    for (const b of dailyBuckets) {
      series.push({
        label: b.label,
        fullLabel: b.fullLabel,
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        outputTokens: b.outputTokens,
        costUsd: Number(b.costUsd.toFixed(4)),
        events: b.events,
      });
    }

    const firstWeekdayMon0 = (dayKeys[0].date.getDay() + 6) % 7; // 0=Mon..6=Sun
    const maxDay = Math.max(1, ...dailyBuckets.map((b) => b.totalTokens));
    const cells = [];
    for (let s = 0; s < firstWeekdayMon0; s++) {
      cells.push({
        placeholder: true,
        label: "",
        shortTag: "",
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        events: 0,
        level: -1,
      });
    }
    for (const b of dailyBuckets) {
      cells.push({
        label: b.key,
        shortTag: b.key.split("-")[2] || "",
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        costUsd: Number(b.costUsd.toFixed(4)),
        events: b.events,
        level: b.totalTokens === 0 ? 0 : Math.min(4, Math.ceil((b.totalTokens / maxDay) * 4)),
      });
    }
    heatmap = {
      mode: "30d",
      cols: 7,
      rows: Math.ceil(cells.length / 7),
      colLabels: ["一", "二", "三", "四", "五", "六", "日"],
      rowLabels: [],
      cells,
    };
  }

  const totalInput = totalUncached + totalCached + totalCacheCreate;
  const totalTokens = totalInput + totalOutput + totalReasoning;
  const cacheHitRate = totalInput > 0 ? Number(((totalCached / totalInput) * 100).toFixed(1)) : 0;
  const avgTokPerSec =
    globalSecWithTiming > 0 ? Number((globalOutWithTiming / globalSecWithTiming).toFixed(1)) : null;

  return {
    range,
    totals: {
      totalTokens,
      inputTokens: totalInput,
      uncachedInputTokens: totalUncached,
      cachedInputTokens: totalCached,
      cacheCreationTokens: totalCacheCreate,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      cacheHitRate,
      costUsd: Number(totalCost.toFixed(4)),
      activeEvents: events.length,
      avgTokPerSec,
    },
    series,
    heatmap,
    byProviderModel,
  };
}

function buildOverview({ fs, path, os, sqlite, threadId, range = "1d" }) {
  const warnings = [];
  const ratesDoc = loadRatesDoc({ fs, path, os });
  const quotas = readSubscriptionQuotas({ fs, path, os }, warnings);
  const thread = readThreadMetrics({ fs, path, os, sqlite, threadId, ratesDoc }, warnings);
  const global = readGlobalUsage({ fs, path, os, sqlite, range, ratesDoc }, warnings);

  return {
    generatedAt: new Date().toISOString(),
    quotas,
    thread,
    global,
    warnings,
  };
}

function handle({ action, query = {}, fs, path, os, sqlite }) {
  if (action === "overview") {
    const range = query.range === "7d" || query.range === "30d" ? query.range : "1d";
    const threadId = typeof query.threadId === "string" && query.threadId.trim() ? query.threadId.trim() : null;
    return buildOverview({ fs, path, os, sqlite, threadId, range });
  }
  if (action === "quotas") {
    const warnings = [];
    return { quotas: readSubscriptionQuotas({ fs, path, os }, warnings), warnings };
  }
  if (action === "health") {
    return { ok: true, ts: Date.now() };
  }
  return { error: `Unknown action: ${action}` };
}

module.exports = {
  handle,
  buildOverview,
  readSubscriptionQuotas,
  readThreadMetrics,
  readGlobalUsage,
  readAntigravityDbUsage,
  antigravityRateModel,
  estimateCostUsd,
};
