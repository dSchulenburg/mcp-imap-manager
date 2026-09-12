import { test } from "node:test";
import assert from "node:assert/strict";
import { hasOwnLimiter, generalLimiter } from "../src/rate-limit.mjs";

// Laesst den Limiter einmal laufen. Ergebnis true = geblockt (Antwort gesendet, kein next),
// false = durchgelassen (next aufgerufen). Ohne das Aufloesen beim Senden haengt der Test,
// weil express-rate-limit im Blockfall next() nie aufruft.
function runLimiter(req) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {}, getHeader() {}, on() {},
      status() { return this; },
      send() { resolve(true); return this; },
      json() { resolve(true); return this; },
    };
    generalLimiter(req, res, () => resolve(false));
  });
}

test("hasOwnLimiter: /mcp und /health sind aus dem allgemeinen Limiter ausgenommen", () => {
  for (const p of ["/mcp", "/mcp/", "/mcp/foo", "/health", "/health/deep"]) {
    assert.equal(hasOwnLimiter(p), true, p);
  }
});

test("hasOwnLimiter: alle anderen Pfade bleiben im allgemeinen Limiter", () => {
  for (const p of ["/", "/mcpx", "/api/mcp", "/healthz", "/foo"]) {
    assert.equal(hasOwnLimiter(p), false, p);
  }
});

test("generalLimiter laesst /mcp durch, auch nach 100 Requests", async () => {
  // express-rate-limit ruft skip(req) vor dem Zaehlen auf; wir pruefen den Middleware-Vertrag direkt.
  const mk = (path) => ({ path, ip: "203.0.113.7", headers: {}, app: { get: () => 1 }, method: "POST", url: path, socket: { remoteAddress: "203.0.113.7" } });
  let blocked = 0;
  for (let i = 0; i < 150; i++) {
    if (await runLimiter(mk("/mcp"))) blocked++;
  }
  assert.equal(blocked, 0);
});

test("generalLimiter blockt einen fremden Pfad nach 100 Requests (Gegenprobe fuer den Test darueber)", async () => {
  const mk = (path) => ({ path, ip: "203.0.113.8", headers: {}, app: { get: () => 1 }, method: "GET", url: path, socket: { remoteAddress: "203.0.113.8" } });
  let blocked = 0;
  for (let i = 0; i < 150; i++) {
    if (await runLimiter(mk("/foo"))) blocked++;
  }
  assert.equal(blocked, 50);
});
