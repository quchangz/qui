(() => {
  if (window.__T3_PLUGINS_LOADED__) return;
  window.__T3_PLUGINS_LOADED__ = true;

  const LOCAL_STATE_PREFIX = "t3p:state:";
  const registry = new Map();
  let currentManifest = { version: 1, plugins: [] };

  function readLocalState(pluginId) {
    try {
      const raw = window.localStorage.getItem(LOCAL_STATE_PREFIX + pluginId);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLocalState(pluginId, data) {
    try {
      window.localStorage.setItem(LOCAL_STATE_PREFIX + pluginId, JSON.stringify(data));
    } catch {
      // ignore storage quota errors
    }
  }

  function resolveApiBase() {
    try {
      if (typeof window.__T3_PLUGINS_API_BASE__ === "string") {
        return window.__T3_PLUGINS_API_BASE__.replace(/\/+$/, "");
      }
      if (window.location && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
        return "";
      }
      const bridge = window.desktopBridge;
      if (bridge && typeof bridge.getLocalEnvironmentBootstraps === "function") {
        const list = bridge.getLocalEnvironmentBootstraps();
        if (Array.isArray(list) && list.length > 0) {
          const primary =
            list.find((b) => b && typeof b.httpBaseUrl === "string" && b.httpBaseUrl && !b.runningDistro) ||
            list.find((b) => b && typeof b.httpBaseUrl === "string" && b.httpBaseUrl);
          if (primary && primary.httpBaseUrl) {
            return String(primary.httpBaseUrl).replace(/\/+$/, "");
          }
        }
      }
    } catch {
      // ignore and fall back to loopback default
    }
    throw new Error("QUI local backend is not ready");
  }

  function apiUrl(p) {
    const path = String(p || "");
    if (/^https?:\/\//i.test(path)) return path;
    const base = resolveApiBase();
    return base + (path.startsWith("/") ? path : `/${path}`);
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  }

  const api = {
    version: "1.0.0",
    get apiBase() {
      return resolveApiBase();
    },
    apiUrl,
    get manifest() {
      return currentManifest;
    },
    registry,
    register(def) {
      if (!def || typeof def.id !== "string" || !def.id.trim()) {
        throw new Error("Plugin definition requires a non-empty id.");
      }
      const entry = { ...def, registeredAt: Date.now() };
      registry.set(def.id, entry);
      window.dispatchEvent(new CustomEvent("t3plugins:registered", { detail: entry }));
      return entry;
    },
    getPlugins() {
      const list = Array.isArray(currentManifest?.plugins) ? currentManifest.plugins : [];
      return list.map((item) => ({
        ...item,
        runtime: registry.get(item.id) || null,
      }));
    },
    async getState(pluginId, fallback = {}) {
      const local = readLocalState(pluginId);
      try {
        const server = await fetchJson(
          apiUrl(`/__t3_plugins__/state/${encodeURIComponent(pluginId)}?t=${Date.now()}`),
          { cache: "no-store" }
        );
        if (server && typeof server === "object" && Object.keys(server).length > 0) {
          const merged = { ...(fallback || {}), ...server };
          writeLocalState(pluginId, merged);
          return merged;
        }
      } catch (err) {
        console.warn(`[T3Plugins] failed to read server state for ${pluginId}:`, err);
      }
      if (local && Object.keys(local).length > 0) {
        return { ...(fallback || {}), ...local };
      }
      return { ...(fallback || {}) };
    },
    async saveState(pluginId, data) {
      writeLocalState(pluginId, data);
      try {
        await fetchJson(apiUrl(`/__t3_plugins__/state/${encodeURIComponent(pluginId)}`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        return true;
      } catch (err) {
        console.warn(`[T3Plugins] failed to persist state for ${pluginId}:`, err);
        return false;
      }
    },
    async saveManifest(nextManifest) {
      currentManifest = nextManifest;
      await fetchJson(apiUrl("/__t3_plugins__/manifest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextManifest),
      });
      return currentManifest;
    },
    async togglePlugin(pluginId, enabled) {
      const next = {
        version: currentManifest?.version || 1,
        plugins: (currentManifest?.plugins || []).map((p) =>
          p.id === pluginId ? { ...p, enabled: !!enabled } : p
        ),
      };
      return await api.saveManifest(next);
    },
    reload() {
      window.location.reload();
    },
  };

  window.T3Plugins = api;

  async function boot() {
    try {
      const manifest = await fetchJson(apiUrl(`/__t3_plugins__/manifest.json?t=${Date.now()}`), {
        cache: "no-store",
      });
      if (manifest && Array.isArray(manifest.plugins)) {
        currentManifest = manifest;
      }
    } catch (err) {
      console.warn("[T3Plugins] unable to load manifest:", err);
      return;
    }

    const ts = Date.now();
    const head = document.head || document.documentElement;
    for (const plugin of currentManifest.plugins) {
      if (!plugin || plugin.enabled === false) continue;
      const styles = Array.isArray(plugin.styles) ? plugin.styles : [];
      for (const rel of styles) {
        try {
          const res = await fetch(apiUrl(`/__t3_plugins__/files/${rel}?t=${ts}`), {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const cssText = await res.text();
          if (/^\s*</.test(cssText)) throw new Error("Unexpected HTML response for style");
          const style = document.createElement("style");
          style.dataset.t3pStyle = plugin.id;
          style.dataset.t3pSrc = rel;
          style.textContent = cssText;
          head.appendChild(style);
        } catch (err) {
          console.error(`[T3Plugins] failed to inject style ${rel}:`, err);
        }
      }
      const scripts = Array.isArray(plugin.scripts) ? plugin.scripts : [];
      for (const rel of scripts) {
        try {
          const res = await fetch(apiUrl(`/__t3_plugins__/files/${rel}?t=${ts}`), {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const jsText = await res.text();
          if (!jsText || /^\s*</.test(jsText)) {
            throw new Error("Unexpected HTML response for script");
          }
          const script = document.createElement("script");
          script.dataset.t3pScript = plugin.id;
          script.dataset.t3pSrc = rel;
          script.textContent = `${jsText}\n//# sourceURL=t3-plugins/${rel}`;
          head.appendChild(script);
        } catch (err) {
          console.error(`[T3Plugins] failed to inject script ${rel}:`, err);
        }
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }
})();
