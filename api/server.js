#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const API_PREFIX = "/api/submarine/v1";
const STALE_AFTER_SECONDS = 90;
const MAX_HISTORY = 360;
const MAX_BODY_BYTES = 131_072;
const MAX_SERVERS = 256;
const RATE_LIMIT_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 4_096;
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().split(/\s+/).filter(Boolean).join(" ").slice(0, maxLength);
  return cleaned || fallback;
}

export function serverGroupForAddress(address) {
  const groupId = createHash("sha256").update(address).digest("hex").slice(0, 10).toUpperCase();
  return `Network ${groupId}`;
}

function clientAddress(request) {
  const forwarded = request.headers["x-real-ip"];
  const rawAddress = typeof forwarded === "string" && forwarded.trim()
    ? forwarded.trim()
    : request.socket.remoteAddress || "";
  const address = rawAddress.toLowerCase().startsWith("::ffff:") ? rawAddress.slice(7) : rawAddress;
  if (!isIP(address)) throw new HttpError(400, "invalid_source_ip");
  return address;
}

export class TelemetryRateLimiter {
  #clients = new Map();

  constructor({ requests = RATE_LIMIT_REQUESTS, windowMs = RATE_LIMIT_WINDOW_MS, maxKeys = RATE_LIMIT_MAX_KEYS } = {}) {
    this.requests = requests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  consume(clientAddress, now = Date.now()) {
    const current = this.#clients.get(clientAddress);
    if (!current || now - current.windowStarted >= this.windowMs) {
      if (!current && this.#clients.size >= this.maxKeys) this.#prune(now);
      if (!current && this.#clients.size >= this.maxKeys) return false;
      this.#clients.set(clientAddress, { windowStarted: now, count: 1 });
      return true;
    }
    if (current.count >= this.requests) return false;
    current.count += 1;
    return true;
  }

  #prune(now) {
    for (const [address, entry] of this.#clients) {
      if (now - entry.windowStarted >= this.windowMs) this.#clients.delete(address);
    }
  }
}

export class ServerCapacityError extends Error {}

export function finiteNumber(value, minimum = 0, maximum = 1_000_000_000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return null;
  return value;
}

function integer(value, minimum = 0, maximum = 1_000_000_000) {
  const number = finiteNumber(value, minimum, maximum);
  return number !== null && Number.isInteger(number) ? number : null;
}

export function cleanStats(raw) {
  if (!isObject(raw)) throw new Error("stats must be an object");

  const fields = {
    uptime_seconds: [0, 315_576_000],
    tps_current: [0, 20],
    load_current_percent: [0, 100],
    tps_average: [0, 20],
    load_average_percent: [0, 100],
    online: [0, 100_000],
    max_players: [0, 100_000],
    network_upload_kb_s: [0, 1_000_000],
    network_download_kb_s: [0, 1_000_000],
    thread_count: [0, 100_000],
  };
  const integerFields = new Set(["uptime_seconds", "online", "max_players", "thread_count"]);
  const result = {};
  for (const [key, [minimum, maximum]] of Object.entries(fields)) {
    result[key] = integerFields.has(key)
      ? integer(raw[key], minimum, maximum)
      : finiteNumber(raw[key], minimum, maximum);
  }

  const memory = isObject(raw.memory_mb) ? raw.memory_mb : {};
  result.memory_mb = Object.fromEntries(
    ["main", "total", "virtual", "heap", "max"].map((key) => [key, finiteNumber(memory[key], 0, 10_000_000)])
  );

  result.worlds = [];
  if (Array.isArray(raw.worlds)) {
    for (const world of raw.worlds.slice(0, 64)) {
      if (!isObject(world)) continue;
      result.worlds.push({
        folder: safeText(world.folder, "world", 80),
        name: safeText(world.name, "", 80),
        chunks: integer(world.chunks, 0, 10_000_000),
        entities: integer(world.entities, 0, 10_000_000),
        tiles: integer(world.tiles, 0, 10_000_000),
        tick_ms: finiteNumber(world.tick_ms, 0, 60_000),
      });
    }
  }
  return result;
}

export class TelemetryStore {
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    let state;
    try {
      state = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { servers: {} };
      throw error;
    }
    if (!isObject(state) || !isObject(state.servers)) throw new Error("Stored telemetry state is invalid");
    return state;
  }

  async append(serverId, metadata, snapshot) {
    const operation = this.#writeQueue.then(async () => {
      const state = await this.read();
      if (!Object.hasOwn(state.servers, serverId) && Object.keys(state.servers).length >= MAX_SERVERS) {
        throw new ServerCapacityError("server_limit_reached");
      }
      const current = isObject(state.servers[serverId]) ? state.servers[serverId] : {};
      const history = Array.isArray(current.history) ? current.history : [];
      history.push(snapshot);
      state.servers[serverId] = { ...current, ...metadata, history: history.slice(-MAX_HISTORY), latest: snapshot };
      await this.#write(state);
    });
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async #write(state) {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const temporaryPath = resolve(directory, `.telemetry-${process.pid}-${randomUUID()}`);
    let file;
    try {
      file = await open(temporaryPath, "wx", 0o640);
      await file.writeFile(JSON.stringify(state));
      await file.sync();
      await file.close();
      file = null;
      await rename(temporaryPath, this.filePath);
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporaryPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

export function publicSnapshot(serverId, stored, now) {
  const entry = isObject(stored) ? stored : {};
  const latest = isObject(entry.latest) ? entry.latest : null;
  const lastSeen = typeof latest?.timestamp === "number" ? latest.timestamp : null;
  const history = Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY) : [];
  const online = lastSeen !== null && now - lastSeen <= STALE_AFTER_SECONDS;
  return {
    id: serverId,
    name: safeText(entry.name, serverId, 80),
    group: safeText(entry.group, "Servers", 80),
    address: "",
    online,
    last_seen: lastSeen,
    stats: latest?.stats ?? null,
    history,
  };
}

async function readRequestJson(request) {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) throw new HttpError(400, "invalid_content_length");
    const declaredLength = Number(contentLength);
    if (declaredLength <= 0) throw new HttpError(400, "invalid_body_size");
    if (declaredLength > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpError(413, "invalid_body_size");
    }
  }

  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw new HttpError(413, "invalid_body_size");
  if (totalBytes === 0) throw new HttpError(400, "invalid_body_size");

  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export class DashboardServer {
  constructor({ telemetryStore, host = "127.0.0.1", port = 8765, rateLimiter = new TelemetryRateLimiter() }) {
    this.telemetryStore = telemetryStore;
    this.host = host;
    this.port = port;
    this.rateLimiter = rateLimiter;
    this.httpServer = null;
  }

  async listen() {
    this.httpServer = createServer((request, response) => {
      request.setTimeout(8_000, () => request.destroy());
      void this.#handle(request, response);
    });
    this.httpServer.headersTimeout = 5_000;
    this.httpServer.requestTimeout = 8_000;
    this.httpServer.keepAliveTimeout = 2_000;
    await new Promise((resolveListen, rejectListen) => {
      this.httpServer.once("error", rejectListen);
      this.httpServer.listen(this.port, this.host, resolveListen);
    });
    return this.httpServer.address();
  }

  async close() {
    if (!this.httpServer?.listening) return;
    await new Promise((resolveClose, rejectClose) => {
      this.httpServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  async #handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "GET") {
        await this.#get(path, response);
      } else if (request.method === "POST") {
        await this.#post(path, request, response);
      } else {
        throw new HttpError(405, "method_not_allowed");
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError) {
        this.#respond(response, error.status, { error: error.code });
        return;
      }
      console.error("Dashboard request failed:", error.message);
      this.#respond(response, 500, { error: "internal_error" });
    }
  }

  async #get(path, response) {
    if (path === API_PREFIX) {
      this.#respond(response, 200, {
        service: "submarine-dashboard",
        version: 1,
        endpoints: [
          { method: "GET", path: "/health" },
          { method: "GET", path: "/servers" },
          { method: "GET", path: "/servers/{id}" },
          { method: "POST", path: "/telemetry" },
        ],
      });
      return;
    }
    if (path === `${API_PREFIX}/health`) {
      this.#respond(response, 200, { ok: true, service: "submarine-dashboard" });
      return;
    }
    if (path === `${API_PREFIX}/servers`) {
      await this.#getServers(response);
      return;
    }
    if (path.startsWith(`${API_PREFIX}/servers/`)) {
      let serverId;
      try {
        serverId = decodeURIComponent(path.slice(`${API_PREFIX}/servers/`.length));
      } catch {
        throw new HttpError(400, "invalid_server_id");
      }
      await this.#getServer(serverId, response);
      return;
    }
    if (path.startsWith(API_PREFIX)) throw new HttpError(404, "not_found");
    throw new HttpError(404, "not_found");
  }

  async #post(path, request, response) {
    if (path !== `${API_PREFIX}/telemetry`) throw new HttpError(404, "not_found");
    const address = clientAddress(request);
    if (!this.rateLimiter.consume(address)) throw new HttpError(429, "rate_limit_exceeded");
    const payload = await readRequestJson(request);
    if (!isObject(payload)) throw new HttpError(400, "invalid_payload");

    const serverId = payload.server_id;
    if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) {
      throw new HttpError(400, "invalid_server_id");
    }

    let stats;
    try {
      stats = cleanStats(payload.stats);
    } catch (error) {
      throw new HttpError(400, error.message);
    }

    const snapshot = { timestamp: Date.now() / 1000, stats };
    const metadata = {
      name: safeText(payload.server_name, serverId, 80),
      group: serverGroupForAddress(address),
    };
    try {
      await this.telemetryStore.append(serverId, metadata, snapshot);
    } catch (error) {
      if (error instanceof ServerCapacityError) throw new HttpError(429, error.message);
      throw new HttpError(500, "storage_failure");
    }
    this.#respond(response, 202, { accepted: true, server_id: serverId });
  }

  async #getServers(response) {
    let state;
    try {
      state = await this.telemetryStore.read();
    } catch {
      throw new HttpError(500, "storage_failure");
    }
    const now = Date.now() / 1000;
    const servers = Object.keys(state.servers).sort().map((serverId) =>
      publicSnapshot(serverId, state.servers[serverId], now)
    );
    const totalOnline = servers.reduce((total, server) =>
      total + (server.online ? server.stats?.online || 0 : 0), 0
    );
    this.#respond(response, 200, { generated_at: now, total_online: totalOnline, servers });
  }

  async #getServer(serverId, response) {
    let state;
    try {
      state = await this.telemetryStore.read();
    } catch {
      throw new HttpError(500, "storage_failure");
    }
    if (!Object.hasOwn(state.servers, serverId)) throw new HttpError(404, "unknown_server");
    this.#respond(response, 200, publicSnapshot(serverId, state.servers[serverId], Date.now() / 1000));
  }

  #respond(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }
}

export async function createDashboardFromEnvironment() {
  const statePath = resolve(process.env.SUBMARINE_DASHBOARD_STORE || `${ROOT}/data/state.json`);
  const host = process.env.SUBMARINE_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.SUBMARINE_DASHBOARD_PORT || "8765");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid SUBMARINE_DASHBOARD_PORT");

  return new DashboardServer({
    telemetryStore: new TelemetryStore(statePath),
    host,
    port,
  });
}

async function main() {
  const app = await createDashboardFromEnvironment();
  const address = await app.listen();
  console.log(`Submarine dashboard API listening on ${address.address}:${address.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("Could not start Submarine dashboard API:", error.message);
    process.exitCode = 1;
  });
}
