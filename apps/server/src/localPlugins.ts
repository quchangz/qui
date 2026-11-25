// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off cryptoRandomUUIDInEffect:off - Local Node plugins use native modules; JSON and storage failures are handled at this boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "./config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "./httpCors.ts";
import { requestUrl } from "./requestUrl.ts";

export const LOCAL_PLUGIN_PREFIX = "/__t3_plugins__/";
const idPattern = /^[a-z0-9_-]{1,64}$/i;
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);
const mimeTypes = new Map([
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
]);
const require = NodeModule.createRequire(import.meta.url);
const respond = (body: string, status = 200, contentType = "text/plain") =>
  HttpServerResponse.text(body, {
    status,
    contentType,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

function isLocalRequest(request: HttpServerRequest.HttpServerRequest, url: URL): boolean {
  const address = Option.getOrUndefined(request.remoteAddress);
  const origin = request.headers.origin;
  return (
    !!address &&
    loopback.has(address) &&
    loopback.has(url.hostname) &&
    !request.headers.forwarded &&
    !request.headers["x-forwarded-for"] &&
    (origin
      ? origin === url.origin || DESKTOP_RENDERER_ORIGINS.some((allowed) => allowed === origin)
      : request.headers["sec-fetch-site"] !== "cross-site")
  );
}

async function readWithin(root: string, file: string): Promise<string> {
  const real = await NodeFSP.realpath(file);
  if (!real.startsWith(root + NodePath.sep)) throw new Error("File outside plugin directory");
  return NodeFSP.readFile(real, "utf8");
}

const seededRoots = new Map<string, Promise<void>>();

function resolveBuiltinPluginsDir(): string | undefined {
  const candidates = [
    process.env.T3CODE_BUILTIN_PLUGINS_DIR?.trim(),
    NodePath.resolve(import.meta.dirname, "../../../../builtin-plugins"),
    NodePath.resolve(import.meta.dirname, "../../../builtin-plugins"),
    NodePath.resolve(import.meta.dirname, "../../desktop/resources/builtin-plugins"),
    NodePath.resolve(import.meta.dirname, "../../../apps/desktop/resources/builtin-plugins"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) =>
    NodeFS.existsSync(NodePath.join(candidate, "plugins.json")),
  );
}

async function copyMissingDir(src: string, dst: string): Promise<void> {
  await NodeFSP.mkdir(dst, { recursive: true });
  for (const entry of await NodeFSP.readdir(src, { withFileTypes: true })) {
    const srcPath = NodePath.join(src, entry.name);
    const dstPath = NodePath.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyMissingDir(srcPath, dstPath);
    } else if (!NodeFS.existsSync(dstPath)) {
      await NodeFSP.copyFile(srcPath, dstPath);
    }
  }
}

async function seedBuiltinPlugins(pluginsDir: string): Promise<void> {
  const builtinDir = resolveBuiltinPluginsDir();
  if (!builtinDir) return;
  await NodeFSP.mkdir(pluginsDir, { recursive: true });

  const builtinLoader = NodePath.join(builtinDir, "loader.js");
  const targetLoader = NodePath.join(pluginsDir, "loader.js");
  if (NodeFS.existsSync(builtinLoader) && !NodeFS.existsSync(targetLoader)) {
    await NodeFSP.copyFile(builtinLoader, targetLoader);
  }

  for (const entry of await NodeFSP.readdir(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetSubdir = NodePath.join(pluginsDir, entry.name);
    if (!NodeFS.existsSync(targetSubdir)) {
      await copyMissingDir(NodePath.join(builtinDir, entry.name), targetSubdir);
    }
  }

  const builtinManifestPath = NodePath.join(builtinDir, "plugins.json");
  const targetManifestPath = NodePath.join(pluginsDir, "plugins.json");
  if (!NodeFS.existsSync(builtinManifestPath)) return;
  const builtinManifest = JSON.parse(await NodeFSP.readFile(builtinManifestPath, "utf8")) as {
    version?: number;
    plugins?: Array<{ id?: string }>;
  };
  if (!NodeFS.existsSync(targetManifestPath)) {
    await NodeFSP.writeFile(targetManifestPath, JSON.stringify(builtinManifest, null, 2));
    return;
  }
  try {
    const existing = JSON.parse(await NodeFSP.readFile(targetManifestPath, "utf8")) as {
      version?: number;
      plugins?: Array<{ id?: string }>;
    };
    const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
    const existingIds = new Set(existingPlugins.map((item) => item?.id).filter(Boolean));
    const missing = (builtinManifest.plugins ?? []).filter(
      (item) => item?.id && !existingIds.has(item.id),
    );
    if (missing.length > 0) {
      const merged = {
        version: existing.version ?? builtinManifest.version ?? 1,
        plugins: [...existingPlugins, ...missing],
      };
      await NodeFSP.writeFile(targetManifestPath, JSON.stringify(merged, null, 2));
    }
  } catch {
    // Keep user's existing file untouched if it cannot be parsed.
  }
}

function ensureBuiltinPluginsSeeded(pluginsDir: string): Promise<void> {
  const existing = seededRoots.get(pluginsDir);
  if (existing) return existing;
  const promise = seedBuiltinPlugins(pluginsDir).catch(() => {
    seededRoots.delete(pluginsDir);
  });
  seededRoots.set(pluginsDir, promise);
  return promise;
}

export const handleLocalPluginRequest = Effect.fn("QUI.localPlugins")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) {
  const config = yield* ServerConfig;
  if (config.mode !== "desktop" || !isLocalRequest(request, url)) {
    return respond("Forbidden", 403);
  }
  const pathname = url.pathname.slice(LOCAL_PLUGIN_PREFIX.length);
  const result = /^(state|api|files)\/(.+)$/.exec(pathname);
  const kind = result?.[1];
  const suffix = result?.[2] ?? "";
  const state = kind === "state" && idPattern.test(suffix);
  const manifest =
    request.method === "GET" ? pathname === "manifest.json" : pathname === "manifest";

  if (request.method === "POST") {
    if (!manifest && !state) return respond("Not found", 404);
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      return respond("Expected JSON", 415);
    }
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (Buffer.byteLength(body) > 524288) return respond("Payload too large", 413);
    return yield* Effect.promise(async () => {
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return respond("Invalid JSON", 400);
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (manifest && (!("plugins" in value) || !Array.isArray(value.plugins)))
      ) {
        return respond("Invalid plugin configuration", 400);
      }
      try {
        const root = NodePath.join(config.stateDir, "plugins");
        const dir = state ? NodePath.join(root, "state") : root;
        await NodeFSP.mkdir(dir, { recursive: true });
        const target = NodePath.join(dir, manifest ? "plugins.json" : suffix + ".json");
        const temp = target + "." + crypto.randomUUID() + ".tmp";
        await NodeFSP.writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx" });
        await NodeFSP.rename(temp, target);
        return respond('{"ok":true}', 200, "application/json");
      } catch {
        return respond("Could not save plugin configuration", 500);
      }
    });
  }

  if (request.method !== "GET") return respond("Method not allowed", 405);
  return yield* Effect.promise(async () => {
    try {
      const pluginsDir = NodePath.join(config.stateDir, "plugins");
      await ensureBuiltinPluginsSeeded(pluginsDir);
      const root = await NodeFSP.realpath(pluginsDir);
      if (manifest || state) {
        const file = manifest ? "plugins.json" : NodePath.join("state", suffix + ".json");
        const body = await readWithin(root, NodePath.join(root, file)).catch(() =>
          manifest ? '{"version":1,"plugins":[]}' : "{}",
        );
        return respond(body, 200, "application/json");
      }
      if (kind === "files") {
        const segments = suffix.split("/");
        const contentType = mimeTypes.get(NodePath.extname(suffix).toLowerCase());
        if (
          !contentType ||
          !segments.every((segment) => /^[a-z0-9_-][a-z0-9_.-]*$/i.test(segment))
        ) {
          return respond("Not found", 404);
        }
        const body = await readWithin(root, NodePath.join(root, ...segments));
        return respond(body, 200, contentType);
      }
      if (kind === "api") {
        const [pluginId, action, extra] = suffix.split("/");
        if (
          !pluginId ||
          !action ||
          extra !== undefined ||
          !idPattern.test(pluginId) ||
          !idPattern.test(action)
        ) {
          return respond("Not found", 404);
        }
        const entry = await NodeFSP.realpath(NodePath.join(root, pluginId, "backend.cjs"));
        if (!entry.startsWith(root + NodePath.sep)) return respond("Forbidden", 403);
        const backend = require(entry);
        const query = Object.fromEntries(url.searchParams.entries());
        const result = await backend.handle({
          action,
          query,
          fs: NodeFS,
          path: NodePath,
          os: NodeOS,
          sqlite: NodeSqlite,
          pluginsDir: root,
        });
        return respond(JSON.stringify(result), 200, "application/json");
      }
      return respond("Not found", 404);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return respond("Not found", 404);
      }
      return respond("Plugin request failed", 500);
    }
  });
});

export const layerLocalPluginPostRoute = HttpRouter.add(
  "POST",
  "/__t3_plugins__/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    return Option.isSome(url)
      ? yield* handleLocalPluginRequest(request, url.value)
      : respond("Bad request", 400);
  }),
);
