// Private Email Multi-Collector — FINAL (2026-05-12)
// Fix: this.helpers.httpRequest statt fetch (n8n Task-Runner-Sandbox kennt kein fetch)
// + echtes Error-Surfacing über throw (mit Summary), nicht silent swallow

const MCP_URL = 'https://mcp-imap.dirk-schulenburg.net/mcp';
// API-Key aus n8n-Env-Variable ziehen (oder besser: n8n-Credential). NICHT hardcoden.
const API_KEY = $env.IMAP_MCP_API_KEY;

const accounts = [
  { key: 'gmx', label: 'GMX' },
  { key: 'onecom', label: 'One.com' },
  { key: 'gmail', label: 'Gmail' }
];

async function mcpCall(toolName, args) {
  // MCP-Server antwortet im SSE-Format (Streamable-HTTP-Transport).
  // Wir holen die rohe Response und parsen selbst — n8n's json:true verschluckt SSE.
  const raw = await this.helpers.httpRequest({
    method: 'POST',
    url: MCP_URL,
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
    }),
    returnFullResponse: true,
    json: false
  });

  const contentType = String(raw.headers?.['content-type'] || '').toLowerCase();
  const body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body);

  let data;
  if (contentType.includes('text/event-stream')) {
    // SSE-Parsing: nimm den letzten `data: ...`-Block
    let lastData = null;
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('data: ')) lastData = line.slice(6);
    }
    if (!lastData) {
      throw new Error(`Empty SSE response from ${toolName}. Body preview: ${body.slice(0,200)}`);
    }
    data = JSON.parse(lastData);
  } else {
    data = JSON.parse(body);
  }

  if (data.error) {
    throw new Error(`JSON-RPC error (${toolName}): ${JSON.stringify(data.error)}`);
  }
  if (data.result && data.result.content) {
    const textContent = data.result.content.find(c => c.type === 'text');
    if (textContent) return JSON.parse(textContent.text);
  }
  return null;
}

const results = [];
const summary = {};

for (const account of accounts) {
  summary[account.label] = { listed: 0, read: 0, errors: [] };
  try {
    const listResult = await mcpCall.call(this, 'imap_list_emails', {
      account: account.key,
      criteria: 'UNSEEN',
      folder: 'INBOX',
      limit: 50
    });

    summary[account.label].listed = listResult?.emails?.length || 0;

    if (!listResult?.emails?.length) continue;

    for (const email of listResult.emails) {
      try {
        const full = await mcpCall.call(this, 'imap_read_email', {
          account: account.key,
          uid: email.uid,
          folder: 'INBOX'
        });

        if (!full) {
          summary[account.label].errors.push(`uid=${email.uid}: read returned null`);
          continue;
        }

        let fromAddress = '';
        const fromStr = full.from || email.from || '';
        const emailMatch = fromStr.match(/<([^>]+)>/);
        fromAddress = emailMatch ? emailMatch[1] : fromStr;
        const fromName = fromStr.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || fromAddress;

        let body = full.text || '';
        if (!body && full.html) {
          body = full.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        results.push({
          json: {
            account: account.label,
            subject: full.subject || email.subject || '(Kein Betreff)',
            from: fromAddress,
            fromName,
            to: full.to || '',
            date: full.date || email.date || new Date().toISOString(),
            body: (body || '').substring(0, 5000),
            bodyFull: body || '',
            hasAttachments: (full.attachments || []).length > 0,
            attachmentCount: (full.attachments || []).length,
            attachments: full.attachments || [],
            messageId: full.messageId || email.messageId || '',
            headers: {},
            receivedAt: new Date().toISOString()
          }
        });
        summary[account.label].read += 1;
      } catch (readErr) {
        summary[account.label].errors.push(`uid=${email.uid}: ${readErr.message}`);
      }
    }
  } catch (listErr) {
    summary[account.label].errors.push(`list_emails: ${listErr.message}`);
  }
}

// Total-Failure-Detection: wenn ALLE 3 Accounts nur Errors haben und 0 listed → laut werden.
const allFailed = Object.values(summary).every(s => s.listed === 0 && s.errors.length > 0);
if (allFailed) {
  throw new Error(`All 3 IMAP accounts failed. Summary: ${JSON.stringify(summary, null, 2)}`);
}

// Saubere Semantik: keine echten Mails → leeres Array → Engine wird nicht gerufen.
// Diagnostic-Summary parken wir in workflow staticData, damit es im n8n-UI weiterhin
// auffindbar ist, aber NICHT als Garbage-Item an die Engine geht.
const sd = $getWorkflowStaticData('global');
sd.lastCollectorSummary = summary;
sd.lastCollectorSummaryAt = new Date().toISOString();

return results;
