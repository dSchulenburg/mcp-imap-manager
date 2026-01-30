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
 */

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

export function requireApiKey(req, res, next) {
  // Wenn keine Keys konfiguriert: offen (dev)
  if (apiKeys.size === 0) {
    req.apiUser = 'dev-mode';
    return next();
  }

  // Key aus Header oder Query (standardisiert auf api_key)
  const got = req.get("x-api-key") || req.query.api_key;

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
  console.log(`[Auth] Request from user: ${user}`);
  next();
}

// Hilfsfunktion: Alle konfigurierten User auflisten (für Admin)
export function listApiUsers() {
  return Array.from(apiKeys.values());
}
