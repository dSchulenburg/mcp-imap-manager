/**
 * Konten-Freigabe je Zugang (Task jku): Durchsetzung an den MCP-Werkzeugen.
 * Welche Konten ein Zugang hat, entscheidet auth.mjs (req.apiAccounts).
 */

/** true, wenn das Konto für diese Freigabe sichtbar ist (null = alles erlaubt). */
export function isAccountAllowed(allowed, account) {
  return allowed === null || allowed === undefined || allowed.has(account);
}

// Prüft JEDES String-Argument, dessen Name auf "account" endet (account, sourceAccount von
// smtp_reply), bevor ein Werkzeug läuft. Gesperrt klingt wie nicht vorhanden, damit kein
// Zugang die Kontenliste erraten kann. Neue Werkzeuge sind automatisch abgedeckt, solange
// der Parameter so heißt.
export function guardedTool(mcpServer, allowed) {
  return (name, description, schema, handler) =>
    mcpServer.tool(name, description, schema, async (args, extra) => {
      for (const [key, value] of Object.entries(args || {})) {
        if (/account$/i.test(key) && typeof value === "string" && !isAccountAllowed(allowed, value)) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `Account '${value}' not configured` }) }] };
        }
      }
      return handler(args, extra);
    });
}
