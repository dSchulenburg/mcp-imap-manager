/**
 * Multi-Key Authentication Middleware
 *
 * Unterstützt mehrere API-Keys für verschiedene Benutzer.
 *
 * ENV-Format:
 *   MCP_API_KEY=single-key                     (Abwärtskompatibel)
 *   MCP_API_KEYS=key1:alice,key2:bob,key3:carol  (Multi-User)
 *
 * Der Benutzername wird in req.apiUser gespeichert und geloggt.
 *
 * Konten-Freigabe je Zugang (Bereichstrennung, Task jku):
 *   MCP_KEY_ACCOUNTS=business:post|onecom|gmail;privat:gmx|gmail;schule:iserv|ms365
 * Schlüssel sind die Benutzernamen aus MCP_API_KEYS (keine Geheimnisse doppelt in der .env).
 * req.apiAccounts ist danach ein Set der erlaubten Kontoschlüssel oder null (= alle).
 */

// "user:a|b;user2:c" -> Map(user -> Set). Leere Liste ("user:") = Set ohne Einträge.
export function parseKeyAccounts(spec) {
  const map = new Map();
  for (const entry of String(spec || "").split(";")) {
    const [user, list] = entry.split(":").map((x) => (x || "").trim());
    if (!user) continue;
    map.set(user, new Set(String(list || "").split("|").map((a) => a.trim()).filter(Boolean)));
  }
  return map;
}

const keyAccounts = parseKeyAccounts(process.env.MCP_KEY_ACCOUNTS);

/**
 * Welche Konten darf ein Zugang sehen?
 *
 * @param {string} user         Benutzername aus MCP_API_KEYS ('admin' für MCP_API_KEY, 'dev-mode' ohne Keys)
 * @param {Map<string, Set<string>>} table  Ergebnis von parseKeyAccounts()
 * @returns {Set<string>|null}  erlaubte Kontoschlüssel, oder null = alle Konten
 */
export function allowedAccountsFor(user, table = keyAccounts) {
  if (table.has(user)) return table.get(user);
  // Mittelweg (Dirk 20.10.2026): fail-closed. Nur der Hauptschlüssel (MCP_API_KEY -> 'admin')
  // und der Betrieb ohne Schlüssel sehen alles; jeder andere Zugang braucht einen Eintrag,
  // ein vergessener sieht nichts statt alles.
  if (user === "admin" || user === "dev-mode") return null;
  return new Set();
}

// Parse API Keys aus Umgebungsvariablen
function parseApiKeys() {
  const keys = new Map();

  // Multi-Key Format: key1:user1,key2:user2
  const multiKeys = process.env.MCP_API_KEYS;
  if (multiKeys) {
    multiKeys.split(',').forEach(entry => {
      const [key, user] = entry.trim().split(':');
      if (key) {
        keys.set(key, user || 'anonymous');
      }
    });
  }

  // Fallback: Single Key (abwärtskompatibel)
  const singleKey = process.env.MCP_API_KEY;
  if (singleKey && !keys.has(singleKey)) {
    keys.set(singleKey, 'admin');
  }

  return keys;
}

const apiKeys = parseApiKeys();

// Production: kein Betrieb ohne API Keys
if (apiKeys.size === 0 && process.env.NODE_ENV === 'production') {
  console.error('[Auth] FATAL: Keine API Keys konfiguriert in Production. Server wird beendet.');
  process.exit(1);
}

export function requireApiKey(req, res, next) {
  // Wenn keine Keys konfiguriert: offen (dev)
  if (apiKeys.size === 0) {
    req.apiUser = 'dev-mode';
    req.apiAccounts = allowedAccountsFor('dev-mode');
    return next();
  }

  // Key nur aus Header (nicht Query — Query-Params landen in Logs/Referrern)
  const got = req.get("x-api-key");

  if (!got) {
    return res.status(401).json({ ok: false, error: "unauthorized", message: "API key required" });
  }

  const user = apiKeys.get(got);
  if (!user) {
    console.log(`[Auth] Invalid API key attempt: ${got.substring(0, 8)}...`);
    return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid API key" });
  }

  // User für Logging speichern
  req.apiUser = user;
  req.apiAccounts = allowedAccountsFor(user);
  console.log(`[Auth] Request from user: ${user}`);
  next();
}

// Hilfsfunktion: Alle konfigurierten User auflisten (für Admin)
export function listApiUsers() {
  return Array.from(apiKeys.values());
}
