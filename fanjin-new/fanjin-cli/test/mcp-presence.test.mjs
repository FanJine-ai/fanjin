import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpPresence } from "../bin/mcp-presence.mjs";

test("renews an idle bridge without concurrent requests and removes it after a pending renewal", async () => {
  const actions = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const presence = createMcpPresence({ url: "https://fanjin.top/api/mcp", key: "fixture", intervalMs: 10,
    request: async (url, options) => { assert.equal(url.pathname, "/api/mcp/presence"); actions.push(JSON.parse(options.body)); if (actions.length === 1) await pending; return {}; },
  });
  presence.start(); presence.start(); await delay(35);
  assert.equal(actions.length, 1);
  const stopped = presence.stop(); release(); await stopped; await delay(25);
  assert.deepEqual(actions.map(x => x.action), ["heartbeat", "disconnect"]);
  assert.equal(actions[0].connectionId, actions[1].connectionId);
});
test("idle heartbeats continue and failures never escape to MCP stdout", async () => {
  let attempts = 0;
  const presence = createMcpPresence({ url: "https://fanjin.top/api/mcp", key: "fixture", intervalMs: 10,
    request: async () => { attempts++; throw new Error("network unavailable"); },
  });
  presence.start(); await delay(45); await presence.stop(); assert.ok(attempts >= 3);
});
test("no connection is announced before successful initialization", async () => {
  let called = false;
  const presence = createMcpPresence({ url: "https://fanjin.top/api/mcp", key: "fixture", request: async () => { called = true; return {}; } });
  await presence.stop(); presence.start(); assert.equal(called, false);
});
