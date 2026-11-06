import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { smallJsonExceptMcp, mcpJson, MCP_BODY_LIMIT } from "../src/body-limit.mjs";

// Baut eine Mini-App mit derselben Verdrahtung wie server.mjs:
// global kleiner Parser (ausser exakt /mcp), auf /mcp erst Auth, dann grosser Parser.
function buildApp() {
  const app = express();
  app.use(smallJsonExceptMcp);
  const fakeAuth = (req, res, next) =>
    req.get("x-api-key") === "ok" ? next() : res.status(401).json({ error: "unauthorized" });
  app.all("/mcp", fakeAuth, mcpJson, (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  app.post("/mcp/lagebild", (req, res) => res.json({ ok: true }));
  app.post("/other", (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type || err.message }));
  return app;
}

async function post(app, path, bytes, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const body = JSON.stringify({ blob: "A".repeat(bytes) });
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    return r.status;
  } finally {
    server.close();
  }
}

test("Standardlimit fuer /mcp ist 15mb", () => {
  assert.equal(MCP_BODY_LIMIT, "15mb");
});

test("/mcp mit Schluessel nimmt 300 KB an (vorher 413)", async () => {
  assert.equal(await post(buildApp(), "/mcp", 300 * 1024, { "x-api-key": "ok" }), 200);
});

test("/mcp mit Schluessel nimmt ca. 13,5 MB an (10-MB-Anhang als Base64)", async () => {
  assert.equal(await post(buildApp(), "/mcp", 13.5 * 1024 * 1024, { "x-api-key": "ok" }), 200);
});

test("/mcp ueber dem Limit gibt 413", async () => {
  assert.equal(await post(buildApp(), "/mcp", 16 * 1024 * 1024, { "x-api-key": "ok" }), 413);
});

test("/mcp ohne Schluessel: 401, grosser Body wird nicht erst geparst", async () => {
  assert.equal(await post(buildApp(), "/mcp", 300 * 1024), 401);
});

test("/mcp/lagebild und andere Pfade behalten 100 KB", async () => {
  const app = buildApp();
  assert.equal(await post(app, "/mcp/lagebild", 50 * 1024), 200);
  assert.equal(await post(app, "/mcp/lagebild", 300 * 1024), 413);
  assert.equal(await post(app, "/other", 300 * 1024), 413);
});
