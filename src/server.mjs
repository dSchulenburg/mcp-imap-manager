import express from "express";
import cors from "cors";
import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config, getConfiguredAccounts } from "./config.mjs";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// IMAP Helper Functions
// ============================================================================

/**
 * Create IMAP connection for an account
 */
function createImapConnection(accountKey) {
  const accounts = config.accounts;
  const account = accounts[accountKey];

  if (!account || !account.user || !account.password) {
    throw new Error(`Account '${accountKey}' not configured`);
  }

  return new Imap({
    user: account.user,
    password: account.password,
    host: account.host,
    port: account.port,
    tls: account.tls,
    tlsOptions: { rejectUnauthorized: false },
  });
}

/**
 * Connect to IMAP server
 */
function connectImap(imap) {
  return new Promise((resolve, reject) => {
    imap.once("ready", () => resolve(imap));
    imap.once("error", (err) => reject(err));
    imap.connect();
  });
}

/**
 * Open a mailbox
 */
function openMailbox(imap, mailbox, readOnly = false) {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

/**
 * List all mailboxes/folders
 */
function listMailboxes(imap) {
  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      if (err) reject(err);
      else resolve(boxes);
    });
  });
}

/**
 * Flatten mailbox tree to array
 */
function flattenMailboxes(boxes, prefix = "") {
  const result = [];
  for (const [name, box] of Object.entries(boxes)) {
    const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
    result.push({
      name: fullName,
      delimiter: box.delimiter,
      flags: box.attribs || [],
    });
    if (box.children) {
      result.push(...flattenMailboxes(box.children, fullName));
    }
  }
  return result;
}

/**
 * Move email to another folder
 */
function moveEmail(imap, uid, targetFolder) {
  return new Promise((resolve, reject) => {
    imap.move(uid, targetFolder, (err) => {
      if (err) reject(err);
      else resolve({ success: true, uid, targetFolder });
    });
  });
}

/**
 * Delete email (move to Trash or mark as deleted)
 */
function deleteEmail(imap, uid) {
  return new Promise((resolve, reject) => {
    imap.addFlags(uid, ["\\Deleted"], (err) => {
      if (err) reject(err);
      else {
        imap.expunge((err2) => {
          if (err2) reject(err2);
          else resolve({ success: true, uid, action: "deleted" });
        });
      }
    });
  });
}

/**
 * Remove flags from email(s)
 */
function removeFlags(imap, uids, flags) {
  return new Promise((resolve, reject) => {
    imap.delFlags(uids, flags, (err) => {
      if (err) reject(err);
      else resolve({ success: true, uids, flags, action: "flags_removed" });
    });
  });
}

/**
 * Add flags to email(s)
 */
function addFlags(imap, uids, flags) {
  return new Promise((resolve, reject) => {
    imap.addFlags(uids, flags, (err) => {
      if (err) reject(err);
      else resolve({ success: true, uids, flags, action: "flags_added" });
    });
  });
}

/**
 * Search emails by criteria
 */
function searchEmails(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

/**
 * Fetch email details
 */
function fetchEmails(imap, uids, options = {}) {
  return new Promise((resolve, reject) => {
    if (!uids || uids.length === 0) {
      return resolve([]);
    }

    const emails = [];
    const fetchOptions = {
      bodies: options.bodies || ["HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)"],
      struct: options.struct || false,
    };

    const fetch = imap.fetch(uids, fetchOptions);

    fetch.on("message", (msg, seqno) => {
      const email = { seqno, uid: null, headers: {} };

      msg.on("body", (stream, info) => {
        let buffer = "";
        stream.on("data", (chunk) => (buffer += chunk.toString("utf8")));
        stream.once("end", () => {
          email.rawHeaders = buffer;
          // Parse headers
          const lines = buffer.split(/\r?\n/);
          for (const line of lines) {
            const match = line.match(/^([^:]+):\s*(.*)$/);
            if (match) {
              email.headers[match[1].toLowerCase()] = match[2];
            }
          }
        });
      });

      msg.once("attributes", (attrs) => {
        email.uid = attrs.uid;
        email.flags = attrs.flags;
        email.date = attrs.date;
      });

      msg.once("end", () => {
        emails.push(email);
      });
    });

    fetch.once("error", (err) => reject(err));
    fetch.once("end", () => resolve(emails));
  });
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const mcpServer = new McpServer({
  name: "imap-mcp",
  version: "1.0.0",
});

// ----------------------------------------------------------------------------
// Tool: imap_list_accounts
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_list_accounts",
  "List all configured IMAP accounts",
  {},
  async () => {
    const accounts = getConfiguredAccounts();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              accounts: accounts.map((a) => ({
                key: a.key,
                name: a.name,
                host: a.host,
                user: a.user,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_list_folders
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_list_folders",
  "List all folders/mailboxes for an IMAP account",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
  },
  async ({ account }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);

      const boxes = await listMailboxes(imap);
      const folders = flattenMailboxes(boxes);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                folders: folders.map((f) => f.name),
                count: folders.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_list_emails
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_list_emails",
  "List emails in a folder",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    folder: z.string().default("INBOX").describe("Folder name (default: INBOX)"),
    limit: z.number().default(20).describe("Max number of emails to return"),
    criteria: z
      .string()
      .default("ALL")
      .describe("Search criteria: ALL, UNSEEN, SEEN, RECENT, etc."),
  },
  async ({ account, folder, limit, criteria }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, folder, true);

      // Parse criteria
      const searchCriteria = criteria === "ALL" ? ["ALL"] : [criteria];
      const uids = await searchEmails(imap, searchCriteria);

      // Get last N emails
      const limitedUids = uids.slice(-limit);
      const emails = await fetchEmails(imap, limitedUids);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                folder,
                total: uids.length,
                returned: emails.length,
                emails: emails.map((e) => ({
                  uid: e.uid,
                  from: e.headers.from,
                  subject: e.headers.subject,
                  date: e.headers.date,
                  messageId: e.headers["message-id"],
                  flags: e.flags,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_move_email
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_move_email",
  "Move an email to another folder",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    sourceFolder: z.string().default("INBOX").describe("Source folder"),
    uid: z.number().describe("Email UID to move"),
    targetFolder: z.string().describe("Target folder path"),
  },
  async ({ account, sourceFolder, uid, targetFolder }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, sourceFolder, false);

      const result = await moveEmail(imap, uid, targetFolder);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                action: "moved",
                uid,
                from: sourceFolder,
                to: targetFolder,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_move_by_message_id
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_move_by_message_id",
  "Move an email by Message-ID to another folder",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    sourceFolder: z.string().default("INBOX").describe("Source folder"),
    messageId: z.string().describe("Email Message-ID header"),
    targetFolder: z.string().describe("Target folder path"),
  },
  async ({ account, sourceFolder, messageId, targetFolder }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, sourceFolder, false);

      // Search by Message-ID
      const uids = await searchEmails(imap, [["HEADER", "MESSAGE-ID", messageId]]);

      if (uids.length === 0) {
        imap.end();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Email with Message-ID '${messageId}' not found in ${sourceFolder}`,
              }),
            },
          ],
        };
      }

      const uid = uids[0];
      await moveEmail(imap, uid, targetFolder);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                action: "moved",
                messageId,
                uid,
                from: sourceFolder,
                to: targetFolder,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_delete_email
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_delete_email",
  "Delete an email (marks as deleted and expunges)",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    folder: z.string().default("INBOX").describe("Folder containing the email"),
    uid: z.number().describe("Email UID to delete"),
  },
  async ({ account, folder, uid }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, folder, false);

      await deleteEmail(imap, uid);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                action: "deleted",
                uid,
                folder,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_bulk_move
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_bulk_move",
  "Move multiple emails to a folder",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    sourceFolder: z.string().default("INBOX").describe("Source folder"),
    uids: z.array(z.number()).describe("Array of email UIDs to move"),
    targetFolder: z.string().describe("Target folder path"),
  },
  async ({ account, sourceFolder, uids, targetFolder }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, sourceFolder, false);

      const results = [];
      for (const uid of uids) {
        try {
          await moveEmail(imap, uid, targetFolder);
          results.push({ uid, success: true });
        } catch (err) {
          results.push({ uid, success: false, error: err.message });
        }
      }

      imap.end();

      const successCount = results.filter((r) => r.success).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                action: "bulk_move",
                targetFolder,
                total: uids.length,
                succeeded: successCount,
                failed: uids.length - successCount,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_mark_unseen
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_mark_unseen",
  "Mark emails as unseen/unread by removing the \\Seen flag",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    folder: z.string().default("INBOX").describe("Folder containing the emails"),
    uids: z.array(z.number()).optional().describe("Array of email UIDs to mark unseen (if not provided, marks ALL emails in folder)"),
    all: z.boolean().default(false).describe("Mark ALL emails in folder as unseen"),
  },
  async ({ account, folder, uids, all }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, folder, false);

      let targetUids = uids;

      // If all=true or no UIDs provided, get all emails in folder
      if (all || !uids || uids.length === 0) {
        targetUids = await searchEmails(imap, ["ALL"]);
      }

      if (!targetUids || targetUids.length === 0) {
        imap.end();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                account,
                folder,
                message: "No emails to mark as unseen",
                count: 0,
              }),
            },
          ],
        };
      }

      // Remove \Seen flag from all target UIDs
      await removeFlags(imap, targetUids, ["\\Seen"]);

      imap.end();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                folder,
                action: "marked_unseen",
                count: targetUids.length,
                uids: targetUids.length <= 50 ? targetUids : `${targetUids.length} emails (list truncated)`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ============================================================================
// SMTP Helper Functions
// ============================================================================

/**
 * Create SMTP transporter for an account
 */
function createSmtpTransporter(accountKey) {
  const accounts = config.accounts;
  const account = accounts[accountKey];

  if (!account || !account.user || !account.password) {
    throw new Error(`Account '${accountKey}' not configured`);
  }

  if (!account.smtp) {
    throw new Error(`SMTP not configured for account '${accountKey}'`);
  }

  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.user,
      pass: account.password,
    },
  });
}

// ----------------------------------------------------------------------------
// Tool: smtp_send_email
// ----------------------------------------------------------------------------
mcpServer.tool(
  "smtp_send_email",
  "Send an email via SMTP",
  {
    account: z.string().describe("Account key: onecom, gmx, or gmail"),
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    text: z.string().optional().describe("Plain text body"),
    html: z.string().optional().describe("HTML body (optional, if provided will be used instead of text)"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
    bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
    replyTo: z.string().optional().describe("Reply-to address"),
  },
  async ({ account, to, subject, text, html, cc, bcc, replyTo }) => {
    try {
      const transporter = createSmtpTransporter(account);
      const accountConfig = config.accounts[account];

      const mailOptions = {
        from: `"Dirk Schulenburg" <${accountConfig.user}>`,
        to,
        subject,
        text: text || "",
        html: html || undefined,
        cc: cc || undefined,
        bcc: bcc || undefined,
        replyTo: replyTo || undefined,
      };

      const info = await transporter.sendMail(mailOptions);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                messageId: info.messageId,
                to,
                subject,
                accepted: info.accepted,
                rejected: info.rejected,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }
  }
);

// ============================================================================
// HTTP Endpoints
// ============================================================================

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "imap-mcp", version: "1.0.0" });
});

// Version info
app.get("/version", (req, res) => {
  res.json({
    name: "imap-mcp",
    version: "1.0.0",
    node: process.version,
    accounts: getConfiguredAccounts().map((a) => a.key),
  });
});

// List configured accounts
app.get("/accounts", (req, res) => {
  const accounts = getConfiguredAccounts();
  res.json({
    success: true,
    accounts: accounts.map((a) => ({
      key: a.key,
      name: a.name,
      host: a.host,
      user: a.user,
    })),
  });
});

// Test connection to an account
app.get("/test/:account", async (req, res) => {
  const { account } = req.params;
  let imap;

  try {
    imap = createImapConnection(account);
    await connectImap(imap);

    const boxes = await listMailboxes(imap);
    const folders = flattenMailboxes(boxes);

    imap.end();

    res.json({
      success: true,
      account,
      message: "Connection successful",
      folderCount: folders.length,
      sampleFolders: folders.slice(0, 10).map((f) => f.name),
    });
  } catch (error) {
    if (imap) imap.end();
    res.status(500).json({
      success: false,
      account,
      error: error.message,
    });
  }
});

// MCP Endpoint
app.all("/mcp", async (req, res) => {
  // Check API key if configured
  if (config.apiKey) {
    const providedKey = req.headers["x-api-key"] || req.query.apiKey;
    if (providedKey !== config.apiKey) {
      return res.status(401).json({ error: "Invalid API key" });
    }
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(config.port, () => {
  console.log(`IMAP MCP Server running on port ${config.port}`);
  console.log(`Health check: http://127.0.0.1:${config.port}/health`);
  console.log(`MCP endpoint: http://127.0.0.1:${config.port}/mcp`);

  const accounts = getConfiguredAccounts();
  console.log(`\nConfigured accounts: ${accounts.length}`);
  accounts.forEach((a) => console.log(`  - ${a.key}: ${a.user}`));
});
