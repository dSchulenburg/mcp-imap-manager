import express from "express";

// Body-Limits. express.json() ohne Option begrenzt auf 100 KB und antwortet darueber mit
// HTTP 413. Das brach smtp_send_email/smtp_reply mit Base64-Anhang ab ca. 75 KB Datei
// (gemessen 04.11.2026: PDF 155 KB = ca. 207 KB Base64 -> 413).
//
// Deshalb zwei Parser:
// - global klein (100 KB) fuer alles ausser exakt /mcp, also auch /mcp/lagebild und /test;
// - auf /mcp gross, aber erst NACH requireApiKey eingehaengt. Unangemeldete Anfragen
//   werden so abgewiesen, bevor jemand 15 MB JSON parsen laesst.
//
// 15 MB reichen fuer einen 10-MB-Anhang (Base64 = x 4/3, ca. 13,4 MB) plus JSON-Huelle.
// Per MCP_BODY_LIMIT einstellbar (Syntax von bytes: "15mb", "500kb").
export const MCP_BODY_LIMIT = process.env.MCP_BODY_LIMIT || "15mb";

const smallJson = express.json();

export const mcpJson = express.json({ limit: MCP_BODY_LIMIT });

export function smallJsonExceptMcp(req, res, next) {
  if (req.path === "/mcp" || req.path === "/mcp/") return next();
  return smallJson(req, res, next);
}
