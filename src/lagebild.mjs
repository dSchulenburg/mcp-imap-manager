// Lagebild-Endpunkt fürs claude.ai-Dashboard (Task wq7, Projekt n8i).
//
// Eigener Router unter /mcp/lagebild mit eigenem Schlüssel (LAGEBILD_API_KEYS), getrennt von
// MCP_API_KEYS: Die Hauptschlüssel öffnen schreibende Werkzeuge (verschieben, löschen, senden)
// und sollen nicht in einer Dashboard-Konfiguration liegen. Muster wie teams-mcp/src/lagebild.mjs.
//
// Das Werkzeug nimmt KEIN Konto entgegen: fest post@ (Selbstständigkeit), nur INBOX, nur
// Kopfzeilen, Postfach read-only geöffnet (setzt kein \Seen). Ein geleakter Lagebild-Schlüssel
// kommt also nur an Datum, Absender, Betreff und Gelesen-Status der neuesten post@-Mails.
//
// Jede Antwort ist EIN Inhaltsblock { rows: [...] }: Dashboard-Seiten bekommen nur den ersten Block.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { toJsonText } from "./email-helpers.mjs";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/**
 * Eine Dashboard-Zeile aus einer gefetchten Mail (fetchEmails in server.mjs).
 * Kopfzeilen kommen roh (=?UTF-8?B?…?=), simpleParser dekodiert sie.
 */
export async function postRow(email) {
  const parsed = await simpleParser(email.rawHeaders || "");
  const from = parsed.from?.value?.[0];
  return {
    datum: (parsed.date || email.date || null)?.toISOString?.() ?? null,
    absender: from?.name || from?.address || "(unbekannt)",
    betreff: parsed.subject || "(kein Betreff)",
    ungelesen: !(email.flags || []).includes("\\Seen"),
  };
}

const asRows = (rows) => ({ content: [{ type: "text", text: toJsonText({ rows }) }] });

export function buildLagebildServer({ listInbox }) {
  const s = new McpServer({ name: "imap-mcp-lagebild", version: "0.1.0" });

  s.registerTool(
    "lagebild_post",
    {
      title: "Lagebild: post@",
      description:
        "Neueste Mails im Posteingang von post@dirk-schulenburg.net als EIN JSON { rows } mit datum, absender, " +
        "betreff, ungelesen; neueste zuerst. Ohne Mailtext. Postfach ist fest eingestellt.",
      inputSchema: { top: z.number().int().min(1).max(50).optional().describe("Anzahl (Standard 20)") },
      annotations: READ_ONLY,
    },
    async ({ top = 20 }) => {
      const emails = await listInbox(top);
      const rows = await Promise.all(emails.map(postRow));
      rows.sort((a, b) => String(b.datum ?? "").localeCompare(String(a.datum ?? "")));
      return asRows(rows);
    }
  );

  return s;
}

function parseKeys(spec) {
  const keys = new Map();
  for (const pair of String(spec || "").split(",")) {
    const [key, user] = pair.split(":").map((x) => (x || "").trim());
    if (key) keys.set(key, user || "lagebild");
  }
  return keys;
}

// null, wenn kein Schlüssel konfiguriert ist: Dann wird nichts montiert und /mcp/lagebild
// fällt auf den normalen /mcp-Schutz (fail-closed).
export function makeLagebildRouter({ keysSpec, listInbox }) {
  const keys = parseKeys(keysSpec);
  if (keys.size === 0) return null;
  const router = express.Router();

  router.use((req, res, next) => {
    const auth = req.headers.authorization || "";
    const key = req.headers["x-api-key"] || (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "");
    const user = key && keys.get(key);
    if (!user) return res.status(401).json({ error: "Unauthorized: Lagebild-Schlüssel fehlt oder ist falsch" });
    req.apiUser = `lagebild:${user}`;
    next();
  });

  router.all("/", async (req, res) => {
    const server = buildLagebildServer({ listInbox });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", async () => {
      try { await transport.close?.(); } catch {}
      try { await server.close?.(); } catch {}
    });
    try {
      if (req.body?.method === "tools/call") {
        console.log(`[Tool] ${req.apiUser} called ${req.body.params?.name || "unknown"}`);
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Fehler im Lagebild-Request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  return router;
}
