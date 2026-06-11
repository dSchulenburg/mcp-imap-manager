// DEBUG-VERSION für Code-Node "IMAP MCP - Alle Accounts"
// Zweck: Findet die echte Fehler-Ursache und gibt sie als sichtbare Items zurück.
// Nach der Diagnose schreiben wir die finale, saubere Version.

const MCP_URL = 'https://mcp-imap.dirk-schulenburg.net/mcp';
// API-Key aus n8n-Env-Variable ziehen (oder besser: n8n-Credential). NICHT hardcoden.
const API_KEY = $env.IMAP_MCP_API_KEY;

const diagnostic = [];

async function rawCall(toolName, args) {
  const startedAt = Date.now();
  try {
    const resp = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      })
    });

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await resp.text();

    return {
      httpStatus: resp.status,
      httpStatusText: resp.statusText,
      elapsedMs,
      bodyPreview: bodyText.substring(0, 500),
      bodyLength: bodyText.length,
      headers: Object.fromEntries(resp.headers.entries())
    };
  } catch (err) {
    return {
      threwException: true,
      error: err.message,
      stack: (err.stack || '').substring(0, 500),
      elapsedMs: Date.now() - startedAt
    };
  }
}

// Test 1: gegen MCP-URL, mit Key, GMX-Account
const test1 = await rawCall('imap_list_emails', {
  account: 'gmx',
  criteria: 'UNSEEN',
  folder: 'INBOX',
  limit: 3
});

diagnostic.push({
  json: {
    test: '1_gmx_with_key',
    mcpUrl: MCP_URL,
    apiKeyPrefix: API_KEY.substring(0, 8) + '...',
    apiKeyLength: API_KEY.length,
    ...test1
  }
});

// Test 2: gegen MCP-URL, OHNE Key (sehen, wie der Server bei fehlender Auth reagiert)
const startedAt2 = Date.now();
let test2;
try {
  const r2 = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  test2 = {
    httpStatus: r2.status,
    elapsedMs: Date.now() - startedAt2,
    bodyPreview: (await r2.text()).substring(0, 300)
  };
} catch (err) {
  test2 = { threwException: true, error: err.message, elapsedMs: Date.now() - startedAt2 };
}
diagnostic.push({ json: { test: '2_no_key', ...test2 } });

// Test 3: Network sanity — eine ganz andere Domain (Google) erreichen
const startedAt3 = Date.now();
let test3;
try {
  const r3 = await fetch('https://www.google.com/generate_204');
  test3 = { httpStatus: r3.status, elapsedMs: Date.now() - startedAt3 };
} catch (err) {
  test3 = { threwException: true, error: err.message, elapsedMs: Date.now() - startedAt3 };
}
diagnostic.push({ json: { test: '3_internet_sanity', ...test3 } });

return diagnostic;
