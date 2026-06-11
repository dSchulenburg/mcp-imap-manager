// Private Email Multi-Collector — DIAGNOSTIC VERSION (2026-05-12)
// Drop-in replacement für den Code-Node "IMAP MCP - Alle Accounts"
// Änderungen vs. Original:
//   1. console.log in jedem catch-Block (Fehler werden in Execution-Output sichtbar)
//   2. Pro-Account-Summary am Ende
//   3. Throw bei Total-Zero falls das beabsichtigt wäre (auskommentiert, sonst false-positive)
//   4. Längere Email-Body-Truncation belassen
//
// Hinweis: API_KEY kommt aus $env.IMAP_MCP_API_KEY (n8n-Env-Var). Idealerweise eine
// n8n-Credential statt einer Env-Variable verwenden.

const MCP_URL = 'https://mcp-imap.dirk-schulenburg.net/mcp';
// API-Key aus n8n-Env-Variable ziehen (oder besser: n8n-Credential). NICHT hardcoden.
const API_KEY = $env.IMAP_MCP_API_KEY;

const accounts = [
  { key: 'gmx', label: 'GMX' },
  { key: 'onecom', label: 'One.com' },
  { key: 'gmail', label: 'Gmail' }
];

async function mcpCall(toolName, args) {
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

  // Wichtig: HTTP-Status auch bei "200 mit JSON-RPC-Error" prüfen
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from MCP (${toolName})`);
  }

  const data = await resp.json();

  if (data.error) {
    throw new Error(`JSON-RPC error from MCP (${toolName}): ${JSON.stringify(data.error)}`);
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
    const listResult = await mcpCall('imap_list_emails', {
      account: account.key,
      criteria: 'UNSEEN',
      folder: 'INBOX',
      limit: 50
    });

    summary[account.label].listed = listResult?.emails?.length || 0;

    if (!listResult?.emails?.length) {
      console.log(`[${account.label}] 0 UNSEEN emails in INBOX`);
      continue;
    }

    for (const email of listResult.emails) {
      try {
        const full = await mcpCall('imap_read_email', {
          account: account.key,
          uid: email.uid,
          folder: 'INBOX'
        });

        if (!full) {
          summary[account.label].errors.push(`uid=${email.uid}: read_email returned null`);
          continue;
        }

        let fromAddress = '';
        const fromStr = full.from || email.from || '';
        const emailMatch = fromStr.match(/<([^>]+)>/);
        fromAddress = emailMatch ? emailMatch[1] : fromStr;
        let fromName = fromStr.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || fromAddress;

        let body = full.text || '';
        if (!body && full.html) {
          body = full.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        results.push({
          json: {
            account: account.label,
            subject: full.subject || email.subject || '(Kein Betreff)',
            from: fromAddress,
            fromName: fromName,
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
        console.log(`[${account.label}] read_email uid=${email.uid} FAILED: ${readErr.message}`);
        summary[account.label].errors.push(`uid=${email.uid}: ${readErr.message}`);
      }
    }
  } catch (listErr) {
    console.log(`[${account.label}] list_emails FAILED: ${listErr.message}`);
    summary[account.label].errors.push(`list_emails: ${listErr.message}`);
  }
}

console.log('=== Collector Summary ===');
console.log(JSON.stringify(summary, null, 2));
console.log(`Total emails passed to Processing Engine: ${results.length}`);

// Falls du die Hard-Fail-Variante willst (markiert Execution als Error wenn alle 3 Accounts fehlschlagen):
// const allFailed = Object.values(summary).every(s => s.errors.length > 0 && s.listed === 0);
// if (allFailed) {
//   throw new Error('All 3 IMAP accounts failed — see logs above');
// }

return results;
