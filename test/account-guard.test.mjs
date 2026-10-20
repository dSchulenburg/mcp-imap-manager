import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeyAccounts, allowedAccountsFor } from "../src/auth.mjs";
import { guardedTool, isAccountAllowed } from "../src/account-guard.mjs";

const TABLE = parseKeyAccounts("business:post|onecom|gmail; privat:gmx|gmail ;gesperrt:");

test("parseKeyAccounts: Benutzer -> Kontenmenge, Leerzeichen egal, leere Liste bleibt leer", () => {
  assert.deepEqual([...TABLE.get("business")], ["post", "onecom", "gmail"]);
  assert.deepEqual([...TABLE.get("privat")], ["gmx", "gmail"]);
  assert.equal(TABLE.get("gesperrt").size, 0);
  assert.equal(parseKeyAccounts(undefined).size, 0);
});

test("allowedAccountsFor: eingetragener Zugang bekommt genau seine Konten", () => {
  assert.deepEqual([...allowedAccountsFor("business", TABLE)], ["post", "onecom", "gmail"]);
  assert.equal(allowedAccountsFor("gesperrt", TABLE).size, 0);
});

test("allowedAccountsFor: nicht eingetragen = nichts, außer admin und dev-mode (alles)", () => {
  assert.equal(allowedAccountsFor("kollege1", TABLE).size, 0);
  assert.equal(allowedAccountsFor("admin", TABLE), null);
  assert.equal(allowedAccountsFor("dev-mode", TABLE), null);
});

test("isAccountAllowed: null = alles, Set = nur Mitglieder", () => {
  assert.equal(isAccountAllowed(null, "iserv"), true);
  assert.equal(isAccountAllowed(new Set(["post"]), "post"), true);
  assert.equal(isAccountAllowed(new Set(["post"]), "iserv"), false);
});

// Fängt die registrierten Handler ab, statt einen echten McpServer zu bauen.
function fakeServer() {
  const handlers = {};
  return { handlers, tool: (name, _d, _s, h) => { handlers[name] = h; } };
}

test("guardedTool: gesperrtes Konto erreicht den Handler nicht und klingt wie nicht vorhanden", async () => {
  const srv = fakeServer();
  let called = false;
  guardedTool(srv, new Set(["post"]))("imap_list_emails", "", {}, async () => { called = true; return "ok"; });

  const res = await srv.handlers.imap_list_emails({ account: "iserv" });
  assert.equal(called, false);
  assert.match(res.content[0].text, /Account 'iserv' not configured/);

  assert.equal(await srv.handlers.imap_list_emails({ account: "post" }), "ok");
});

test("guardedTool: sourceAccount (smtp_reply) wird genauso geprüft", async () => {
  const srv = fakeServer();
  let called = false;
  guardedTool(srv, new Set(["post"]))("smtp_reply", "", {}, async () => { called = true; });

  await srv.handlers.smtp_reply({ account: "post", sourceAccount: "ms365" });
  assert.equal(called, false);
});

test("guardedTool: ohne Freigabeliste (null) läuft alles durch", async () => {
  const srv = fakeServer();
  guardedTool(srv, null)("imap_list_folders", "", {}, async () => "ok");
  assert.equal(await srv.handlers.imap_list_folders({ account: "iserv" }), "ok");
});
