import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanStats, DashboardServer, TelemetryRateLimiter, TelemetryStore } from "./server.js";

const api = "/api/submarine/v1";

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), "submarine-dashboard-test-"));
  const app = new DashboardServer({
    telemetryStore: new TelemetryStore(join(directory, "state.json")),
    rateLimiter: new TelemetryRateLimiter({ requests: 120 }),
    port: 0,
  });
  const address = await app.listen();
  try {
    await callback(`http://127.0.0.1:${address.port}`, directory);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const sampleStats = {
  uptime_seconds: 3600,
  tps_current: 19.8,
  load_current_percent: 12.5,
  tps_average: 19.98,
  load_average_percent: 13.2,
  online: 8,
  max_players: 100,
  network_upload_kb_s: 4.2,
  network_download_kb_s: 8.1,
  thread_count: 12,
  memory_mb: { main: 45, total: 620, virtual: 810, heap: 48, max: 2048 },
  worlds: [{ folder: "world", name: "world", chunks: 120, entities: 14, tiles: 8, tick_ms: 1.25 }],
};

test("sanitizes telemetry values and caps world data", () => {
  const stats = cleanStats({
    tps_current: 21,
    online: 2.5,
    load_current_percent: true,
    memory_mb: { main: -1, total: 128 },
    worlds: Array.from({ length: 70 }, (_, index) => ({ folder: `world-${index}`, chunks: index })),
  });

  assert.equal(stats.tps_current, null);
  assert.equal(stats.online, null);
  assert.equal(stats.load_current_percent, null);
  assert.equal(stats.memory_mb.main, null);
  assert.equal(stats.memory_mb.total, 128);
  assert.equal(stats.worlds.length, 64);
  assert.throws(() => cleanStats([]), /stats must be an object/);
});

test("auto-discovers servers and persists telemetry without a registration file", async () => {
  await withServer(async (origin, directory) => {
    const health = await fetch(`${origin}${api}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "submarine-dashboard" });

    const accepted = await fetch(`${origin}${api}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_id: "grief", server_name: "Grief   #1", address: "198.51.100.3:19133", stats: sampleStats }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, server_id: "grief" });

    const listing = await fetch(`${origin}${api}/servers`);
    const payload = await listing.json();
    assert.equal(listing.status, 200);
    assert.equal(payload.total_online, 8);
    assert.equal(payload.servers[0].online, true);
    assert.equal(payload.servers[0].name, "Grief #1");
    assert.match(payload.servers[0].group, /^Network [A-F0-9]{10}$/);
    assert.equal(payload.servers[0].address, "");
    assert.equal(payload.servers[0].history.length, 1);
    assert.equal(payload.servers[0].stats.memory_mb.total, 620);

    const sameNetwork = await fetch(`${origin}${api}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_id: "survival", stats: sampleStats }),
    });
    assert.equal(sameNetwork.status, 202);
    const sameNetworkServer = await fetch(`${origin}${api}/servers/survival`);
    assert.equal((await sameNetworkServer.json()).group, payload.servers[0].group);

    const detail = await fetch(`${origin}${api}/servers/grief`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, "grief");

    const automaticServer = await fetch(`${origin}${api}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.17" },
      body: JSON.stringify({ server_id: "winterspawn", stats: sampleStats }),
    });
    assert.equal(automaticServer.status, 202);
    const differentNetwork = await fetch(`${origin}${api}/servers/winterspawn`);
    assert.notEqual((await differentNetwork.json()).group, payload.servers[0].group);

    const unknown = await fetch(`${origin}${api}/servers/missing`);
    assert.equal(unknown.status, 404);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    assert.equal(state.servers.grief.history.length, 1);
    assert.equal(Object.keys(state.servers).length, 3);
  });
});

test("rejects malformed and oversized telemetry bodies", async () => {
  await withServer(async (origin) => {
    const malformed = await fetch(`${origin}${api}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_json" });

    const oversized = await fetch(`${origin}${api}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(131_073),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "invalid_body_size" });
  });
});

test("rate limits telemetry requests per source IP", () => {
  const limiter = new TelemetryRateLimiter({ requests: 2, windowMs: 1_000, maxKeys: 2 });
  assert.equal(limiter.consume("192.0.2.10", 100), true);
  assert.equal(limiter.consume("192.0.2.10", 200), true);
  assert.equal(limiter.consume("192.0.2.10", 300), false);
  assert.equal(limiter.consume("192.0.2.10", 1_101), true);
});
