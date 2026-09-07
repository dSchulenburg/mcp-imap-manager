/**
 * Echter MCP-Roundtrip gegen den eigenen /mcp-Pfad.
 *
 * Warum `initialize` und nicht `tools/list`: die Server fahren den
 * StreamableHTTPServerTransport stateless (sessionIdGenerator: undefined,
 * frischer McpServer pro Request), ein nacktes tools/list traefe dort auf einen
 * uninitialisierten Server. `initialize` ist in beiden Transport-Modi als erste
 * Nachricht gueltig und durchlaeuft genau die Schicht, die im Mai 2026 drei Tage
 * lang kaputt war, waehrend /health "ok" meldete.
 *
 * Drei Antworten, und die dritte ist die wichtigste:
 *   ok            — Roundtrip stand, `server` kommt aus der echten SDK-Antwort
 *   fail          — der MCP-Pfad ist kaputt, `reason` sagt woran
 *   unconfigured  — kein Key ableitbar, es wurde NICHT gemessen
 *
 * Ohne den dritten Zustand waere das dieselbe Luege eine Etage hoeher: eine
 * Sonde, die mangels Key nie laeuft und trotzdem gruen aussieht.
 */

const PROBE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'health-selfcheck', version: '1.0.0' },
  },
};

export function createMcpSelfCheck({
  port,
  key,
  path = '/mcp',
  ttlMs = 20_000,
  timeoutMs = 4_000,
  now = Date.now,
}) {
  let cached = null;

  return async function selfCheck() {
    if (!key) {
      return {
        mcp: 'unconfigured',
        reason: 'kein API-Key im Prozess — Roundtrip nicht gemessen',
      };
    }

    if (cached && now() - cached.at < ttlMs) {
      return cached.result;
    }

    let result;
    try {
      result = await probe();
    } catch (err) {
      // Nie werfen: ein Wurf hier wuerde /health auf 500 kippen, der
      // Docker-Healthcheck ginge rot und Traefik naehme den Dienst aus dem
      // Routing. Gemeldet wird, abgeschaltet nicht.
      result = { mcp: 'fail', reason: err?.message || String(err) };
    }

    cached = { at: now(), result };
    return result;
  };

  async function probe() {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-api-key': key,
      },
      body: JSON.stringify(PROBE_BODY),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { mcp: 'fail', reason: `HTTP ${res.status}` };
    }

    const message = parseRpcResponse(await res.text());
    if (message.error) {
      return { mcp: 'fail', reason: `jsonrpc ${message.error.code}: ${message.error.message}` };
    }

    return { mcp: 'ok', server: message.result?.serverInfo?.name ?? 'unbekannt' };
  }
}

/**
 * Der Streamable-Transport antwortet je nach Accept-Header als nacktes JSON
 * ODER als SSE-Strom. Beides muss die Sonde lesen koennen — sonst meldet sie
 * einen gesunden Server als kaputt.
 */
function parseRpcResponse(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed);
  }
  const payload = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  return JSON.parse(payload);
}

/**
 * Woher die Sonde ihren eigenen Key nimmt.
 *
 * HEALTH_SELFCHECK_KEY erlaubt einen eigenen, eng geschnittenen Key fuer das
 * Monitoring; ohne den nimmt sie den ersten regulaeren Key des Servers. Findet
 * sie nichts, gibt sie '' zurueck — createMcpSelfCheck meldet dann
 * "unconfigured" statt still gruen auszusehen.
 */
export function deriveSelfCheckKey(env = process.env) {
  if (env.HEALTH_SELFCHECK_KEY) return env.HEALTH_SELFCHECK_KEY;

  const multi = env.MCP_API_KEYS;
  if (multi) {
    for (const entry of multi.split(',')) {
      const key = entry.trim().split(':')[0];
      if (key) return key;
    }
  }

  return env.MCP_API_KEY || '';
}
