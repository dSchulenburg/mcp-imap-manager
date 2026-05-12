import express from "express";
import cors from "cors";
import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config, getConfiguredAccounts } from "./config.mjs";
import { generalLimiter, mcpLimiter, healthLimiter } from "./rate-limit.mjs";
import { requireApiKey } from "./auth.mjs";
import {
  buildAttachments,
  ensureReplyPrefix,
  buildReferences,
  buildQuoteText,
  buildQuoteHtml,
  pickReplyRecipients,
} from "./email-helpers.mjs";

const app = express();
app.set("trust proxy", 1); // Behind Traefik reverse proxy
app.use(cors({
  origin: ['https://claude.ai', 'https://claude.desktop'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization']
}));
app.use(express.json());

// Rate Limiting
app.use(generalLimiter);
app.use("/health", healthLimiter);
app.use("/mcp", mcpLimiter);

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
    tlsOptions: { rejectUnauthorized: (process.env.IMAP_REJECT_UNAUTHORIZED || "true") === "true" },
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
//
// SDK 1.x: one McpServer instance can only attach to a single transport at a
// time. We run StreamableHTTP stateless (sessionIdGenerator: undefined), so
// build a fresh server + transport per /mcp request — otherwise the second
// request throws "Already connected to a transport". Tool registrations are
// wrapped in registerTools() which buildMcpServer() invokes on a new instance.
// ============================================================================

function buildMcpServer() {
  const mcpServer = new McpServer({
    name: "imap-mcp",
    version: "1.0.0",
  });
  registerTools(mcpServer);
  return mcpServer;
}

function registerTools(mcpServer) {

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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
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

// ----------------------------------------------------------------------------
// Tool: imap_read_email
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_read_email",
  "Read the full content of an email by UID (body, headers, attachments info)",
  {
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
    folder: z.string().default("INBOX").describe("Folder containing the email"),
    uid: z.number().describe("Email UID to read"),
  },
  async ({ account, folder, uid }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      await openMailbox(imap, folder, true);

      // Fetch the full email (headers + body)
      const rawEmail = await new Promise((resolve, reject) => {
        const fetch = imap.fetch([uid], { bodies: "", struct: true });
        let emailBuffer = "";

        fetch.on("message", (msg) => {
          msg.on("body", (stream) => {
            stream.on("data", (chunk) => (emailBuffer += chunk.toString("utf8")));
          });
        });

        fetch.once("error", (err) => reject(err));
        fetch.once("end", () => resolve(emailBuffer));
      });

      if (!rawEmail) {
        imap.end();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: `Email with UID ${uid} not found in ${folder}` }),
          }],
        };
      }

      // Parse with mailparser
      const parsed = await simpleParser(rawEmail);

      imap.end();

      // Build response with text body, HTML body, and attachment metadata
      const result = {
        success: true,
        account,
        folder,
        uid,
        from: parsed.from?.text || "",
        to: parsed.to?.text || "",
        cc: parsed.cc?.text || "",
        subject: parsed.subject || "",
        date: parsed.date?.toISOString() || "",
        messageId: parsed.messageId || "",
        text: parsed.text || "",
        html: parsed.html || "",
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };

      // Truncate very large bodies to avoid overwhelming responses
      if (result.text.length > 50000) {
        result.text = result.text.substring(0, 50000) + "\n\n[... truncated, total length: " + parsed.text.length + " chars]";
      }
      if (result.html && result.html.length > 50000) {
        result.html = result.html.substring(0, 50000) + "\n\n[... truncated]";
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: error.message }),
        }],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Folder creation helpers
// ----------------------------------------------------------------------------
function createMailboxIfMissing(imap, name) {
  return new Promise((resolve) => {
    imap.addBox(name, (err) => {
      if (!err) return resolve({ name, created: true, alreadyExists: false });
      const msg = err.message || String(err);
      if (/already exists|ALREADYEXISTS/i.test(msg)) {
        return resolve({ name, created: false, alreadyExists: true });
      }
      resolve({ name, created: false, alreadyExists: false, error: msg });
    });
  });
}

function expandFolderPaths(paths, delimiter) {
  const all = new Set();
  for (const path of paths) {
    const parts = path.split(delimiter);
    for (let i = 1; i <= parts.length; i++) {
      all.add(parts.slice(0, i).join(delimiter));
    }
  }
  return [...all].sort(
    (a, b) => a.split(delimiter).length - b.split(delimiter).length
  );
}

// ----------------------------------------------------------------------------
// Tool: imap_create_folder
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_create_folder",
  "Create a single IMAP folder/mailbox. Use delimiter-separated paths (e.g. 'INBOX.Ablage.Finanzamt' for one.com). Returns success even if folder already exists.",
  {
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
    folderPath: z.string().describe("Full folder path (e.g. 'INBOX.Ablage.Finanzamt')"),
  },
  async ({ account, folderPath }) => {
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      const result = await createMailboxIfMissing(imap, folderPath);
      imap.end();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: !result.error, ...result }, null, 2),
        }],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: error.message }),
        }],
      };
    }
  }
);

// ----------------------------------------------------------------------------
// Tool: imap_create_folder_tree
// ----------------------------------------------------------------------------
mcpServer.tool(
  "imap_create_folder_tree",
  "Create multiple IMAP folders at once. Parent folders are auto-created. Delimiter defaults to '.' (one.com) — use '/' for Gmail.",
  {
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
    paths: z.array(z.string()).describe("List of folder paths (leaf paths — parents are auto-created)"),
    delimiter: z.string().optional().describe("Path delimiter (default: '.')"),
  },
  async ({ account, paths, delimiter }) => {
    const delim = delimiter || ".";
    let imap;
    try {
      imap = createImapConnection(account);
      await connectImap(imap);
      const expanded = expandFolderPaths(paths, delim);
      const results = [];
      for (const name of expanded) {
        results.push(await createMailboxIfMissing(imap, name));
      }
      imap.end();
      const created = results.filter((r) => r.created).length;
      const existed = results.filter((r) => r.alreadyExists).length;
      const failed = results.filter((r) => r.error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: failed.length === 0,
            total: results.length,
            created,
            existed,
            failed: failed.length,
            results,
          }, null, 2),
        }],
      };
    } catch (error) {
      if (imap) imap.end();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: error.message }),
        }],
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

const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().describe("Filename shown in the email"),
      path: z.string().optional().describe("Absolute path on server FS (must be under ATTACHMENT_WHITELIST_DIRS)"),
      content: z.string().optional().describe("Base64-encoded file content (alternative to path)"),
      contentType: z.string().optional().describe("MIME type (auto-detected from filename if omitted)"),
    })
  )
  .optional()
  .describe("Optional file attachments. Each entry needs 'filename' plus either 'path' (whitelisted) or base64 'content'.");

// ----------------------------------------------------------------------------
// Signature helpers
// ----------------------------------------------------------------------------
function appendTextSignature(body, signature) {
  if (!signature) return body || "";
  const base = body || "";
  const sep = base.endsWith("\n") ? "\n" : "\n\n";
  return `${base}${sep}-- \n${signature}`;
}

function appendHtmlSignature(body, signature) {
  if (!signature) return body;
  const sigHtml = signature
    .split("\n")
    .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .join("<br>");
  const block = `<div style="color:#666;font-family:Arial,sans-serif;font-size:10pt;margin-top:1.5em;border-top:1px solid #ccc;padding-top:0.5em">${sigHtml}</div>`;
  if (!body) return block;
  return `${body}${block}`;
}

// ----------------------------------------------------------------------------
// Tool: smtp_send_email
// ----------------------------------------------------------------------------
mcpServer.tool(
  "smtp_send_email",
  "Send an email via SMTP. Signature is auto-appended when account.signature is configured (set SIGNATURE_<ACCOUNT> env var). Use noSignature=true to suppress. For replies that should stay in-thread, use smtp_reply instead.",
  {
    account: z.string().describe("Account key: onecom, post, gmx, gmail, iserv, or ms365"),
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    text: z.string().optional().describe("Plain text body"),
    html: z.string().optional().describe("HTML body (optional, if provided will be used instead of text)"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
    bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
    replyTo: z.string().optional().describe("Reply-to address"),
    noSignature: z.boolean().optional().describe("Suppress auto-appended signature (default: false)"),
    attachments: attachmentSchema,
  },
  async ({ account, to, subject, text, html, cc, bcc, replyTo, noSignature, attachments }) => {
    console.log(`[SMTP] Sending email to ${to} via ${account} (subject: ${subject})`);
    try {
      const builtAttachments = buildAttachments(attachments);
      const transporter = createSmtpTransporter(account);
      const accountConfig = config.accounts[account];
      const signature = !noSignature ? accountConfig.signature : null;

      const mailOptions = {
        from: `"Dirk Schulenburg" <${accountConfig.user}>`,
        to,
        subject,
        text: appendTextSignature(text, signature),
        html: html ? appendHtmlSignature(html, signature) : undefined,
        cc: cc || undefined,
        bcc: bcc || undefined,
        replyTo: replyTo || undefined,
        attachments: builtAttachments,
      };

      // Timeout to prevent hanging on blocked ports
      const sendWithTimeout = Promise.race([
        transporter.sendMail(mailOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SMTP timeout after 15s - check port/firewall")), 15000)
        ),
      ]);

      const info = await sendWithTimeout;
      console.log(`[SMTP] Email sent successfully to ${to} (messageId: ${info.messageId}, attachments: ${builtAttachments?.length || 0})`);

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
                attachmentsCount: builtAttachments?.length || 0,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      console.error(`[SMTP] Failed to send email to ${to}: ${error.message}`);
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

async function fetchOriginalForReply(account, folder, uid) {
  const imap = createImapConnection(account);
  try {
    await connectImap(imap);
    await openMailbox(imap, folder, true);

    const rawEmail = await new Promise((resolve, reject) => {
      const fetch = imap.fetch([uid], { bodies: "", struct: true });
      let buf = "";
      let found = false;
      fetch.on("message", (msg) => {
        found = true;
        msg.on("body", (stream) => {
          stream.on("data", (chunk) => (buf += chunk.toString("utf8")));
        });
      });
      fetch.once("error", reject);
      fetch.once("end", () => (found ? resolve(buf) : reject(new Error(`Email UID ${uid} not found in ${folder}`))));
    });

    const parsed = await simpleParser(rawEmail);
    return parsed;
  } finally {
    try { imap.end(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Tool: smtp_reply
// ----------------------------------------------------------------------------
mcpServer.tool(
  "smtp_reply",
  "Reply to an existing email keeping the IMAP thread intact (sets In-Reply-To + References, prefixes subject with AW:, optionally quotes the original). Reads the original via IMAP using replyToUid.",
  {
    account: z.string().describe("SMTP account to send from (e.g. onecom, post, iserv, ms365)"),
    sourceAccount: z.string().optional().describe("IMAP account to read the original from (defaults to 'account')"),
    sourceFolder: z.string().default("INBOX").describe("Folder containing the original mail"),
    replyToUid: z.number().describe("UID of the original email in sourceFolder"),
    text: z.string().optional().describe("Reply body (plain text). Quoted original is appended below if quoteOriginal=true."),
    html: z.string().optional().describe("Reply body (HTML). If provided, used instead of text."),
    to: z.string().optional().describe("Override recipient. Default: original sender (parsed.from)."),
    cc: z.string().optional().describe("CC override (comma-separated)"),
    bcc: z.string().optional().describe("BCC (comma-separated)"),
    replyAll: z.boolean().default(false).describe("If true and 'to' is empty: reply to original 'from' + 'to' + 'cc' (minus self)"),
    quoteOriginal: z.boolean().default(true).describe("Append the quoted original below the reply body (default: true)"),
    subject: z.string().optional().describe("Override subject (default: 'AW: <original subject>')"),
    noSignature: z.boolean().optional().describe("Suppress auto-appended signature"),
    attachments: attachmentSchema,
  },
  async ({ account, sourceAccount, sourceFolder, replyToUid, text, html, to, cc, bcc, replyAll, quoteOriginal, subject, noSignature, attachments }) => {
    const imapAccount = sourceAccount || account;
    console.log(`[SMTP] Reply via ${account} to UID ${replyToUid} in ${imapAccount}/${sourceFolder}`);
    try {
      const builtAttachments = buildAttachments(attachments);
      const parsed = await fetchOriginalForReply(imapAccount, sourceFolder, replyToUid);

      const accountConfig = config.accounts[account];
      const selfAddr = (accountConfig.user || "").toLowerCase();

      let recipientTo = to;
      let recipientCc = cc;
      if (!recipientTo) {
        const picked = pickReplyRecipients(parsed, { replyAll, selfAddress: selfAddr });
        recipientTo = picked.to;
        if (!recipientCc && picked.cc) recipientCc = picked.cc;
      }

      if (!recipientTo) {
        throw new Error("Could not determine recipient — original mail has no parseable 'from' and no 'to' override given");
      }

      const finalSubject = subject || ensureReplyPrefix(parsed.subject || "");
      const references = buildReferences(parsed.references, parsed.messageId);
      const inReplyTo = parsed.messageId || undefined;

      let bodyText = text || "";
      let bodyHtml = html || undefined;
      if (quoteOriginal) {
        if (bodyHtml) {
          bodyHtml = bodyHtml + buildQuoteHtml(parsed);
        } else {
          bodyText = bodyText + buildQuoteText(parsed);
        }
      }

      const transporter = createSmtpTransporter(account);
      const signature = !noSignature ? accountConfig.signature : null;

      const mailOptions = {
        from: `"Dirk Schulenburg" <${accountConfig.user}>`,
        to: recipientTo,
        subject: finalSubject,
        text: appendTextSignature(bodyText, signature),
        html: bodyHtml ? appendHtmlSignature(bodyHtml, signature) : undefined,
        cc: recipientCc || undefined,
        bcc: bcc || undefined,
        inReplyTo,
        references: references || undefined,
        attachments: builtAttachments,
      };

      const sendWithTimeout = Promise.race([
        transporter.sendMail(mailOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SMTP timeout after 15s - check port/firewall")), 15000)
        ),
      ]);

      const info = await sendWithTimeout;
      console.log(`[SMTP] Reply sent to ${recipientTo} (messageId: ${info.messageId}, inReplyTo: ${inReplyTo})`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                account,
                messageId: info.messageId,
                to: recipientTo,
                cc: recipientCc || null,
                subject: finalSubject,
                inReplyTo: inReplyTo || null,
                references: references || null,
                accepted: info.accepted,
                rejected: info.rejected,
                attachmentsCount: builtAttachments?.length || 0,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      console.error(`[SMTP] Reply failed: ${error.message}`);
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

} // end registerTools()

// ============================================================================
// HTTP Endpoints
// ============================================================================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "imap-mcp",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// Version info
app.get("/version", (req, res) => {
  res.json({
    name: "imap-mcp",
    version: "1.0.0",
    node: process.version,
    accounts: getConfiguredAccounts().length,
  });
});

// List configured accounts
app.get("/accounts", requireApiKey, (req, res) => {
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
app.get("/test/:account", requireApiKey, async (req, res) => {
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

// MCP Endpoint with multi-key auth.
// Per-request McpServer + transport — see buildMcpServer() comment above.
app.all("/mcp", requireApiKey, async (req, res) => {
  const reqServer = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", async () => {
    try { await transport.close?.(); } catch {}
    try { await reqServer.close?.(); } catch {}
  });
  try {
    // Audit: log tool calls with username
    if (req.body?.method === 'tools/call') {
      console.log(`[Tool] ${req.apiUser || 'unknown'} called ${req.body.params?.name || 'unknown'}`);
    }
    await reqServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
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
