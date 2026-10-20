import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { postRow, makeLagebildRouter } from "../src/lagebild.mjs";

const RAW = (from, subject, date) => `From: ${from}\r\nSubject: ${subject}\r\nDate: ${date}\r\n\r\n`;

test("postRow: dekodiert kodierte Kopfzeilen, ungelesen aus den Flags", async () => {
  const row = await postRow({
    rawHeaders: RAW("=?UTF-8?Q?J=C3=B6rg_M=C3=BCller?= <j@example.org>", "=?UTF-8?B?UmVjaG51bmcgw7xiZXIgMTI5IOKCrA==?=", "Mon, 20 Oct 2026 09:15:00 +0200"),
    flags: [],
  });
  assert.deepEqual(row, { datum: "2026-10-20T07:15:00.000Z", absender: "Jörg Müller", betreff: "Rechnung über 129 €", ungelesen: true });
});

test("postRow: ohne Namen die Adresse, \\Seen = gelesen, fehlender Betreff wird benannt", async () => {
  const row = await postRow({ rawHeaders: "From: kanzlei@example.org\r\n\r\n", flags: ["\\Seen"] });
  assert.equal(row.absender, "kanzlei@example.org");
  assert.equal(row.betreff, "(kein Betreff)");
  assert.equal(row.ungelesen, false);
});

// Router auf einem Wegwerf-Port, Antwort roh lesen (SSE oder JSON).
async function call(router, headers, body) {
  const app = express();
  app.use(express.json());
  app.use("/mcp/lagebild", router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/mcp/lagebild`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    srv.close();
  }
}

const CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lagebild_post", arguments: { top: 2 } } };

test("makeLagebildRouter: ohne Schlüssel-Konfiguration wird nichts montiert", () => {
  assert.equal(makeLagebildRouter({ keysSpec: "", listInbox: async () => [] }), null);
});

test("makeLagebildRouter: falscher Schlüssel = 401, Postfach wird nicht angefasst", async () => {
  let touched = false;
  const router = makeLagebildRouter({ keysSpec: "geheim:dashboard", listInbox: async () => { touched = true; return []; } });
  const res = await call(router, { "x-api-key": "falsch" }, CALL);
  assert.equal(res.status, 401);
  assert.equal(touched, false);
});

test("makeLagebildRouter: Bearer-Schlüssel liefert EINEN Block { rows }, neueste zuerst", async () => {
  let asked;
  const listInbox = async (top) => {
    asked = top;
    return [
      { rawHeaders: RAW("a@example.org", "alt", "Mon, 19 Oct 2026 08:00:00 +0000"), flags: ["\\Seen"] },
      { rawHeaders: RAW("b@example.org", "neu", "Tue, 20 Oct 2026 08:00:00 +0000"), flags: [] },
    ];
  };
  const router = makeLagebildRouter({ keysSpec: "geheim:dashboard", listInbox });
  const res = await call(router, { authorization: "Bearer geheim" }, CALL);
  assert.equal(res.status, 200);
  assert.equal(asked, 2);

  const payload = JSON.parse(res.text.match(/^data: (.*)$/m)?.[1] ?? res.text);
  assert.equal(payload.result.content.length, 1);
  const { rows } = JSON.parse(payload.result.content[0].text);
  assert.deepEqual(rows.map((r) => r.betreff), ["neu", "alt"]);
});
