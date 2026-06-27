import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

export const config = {
  port: Number(process.env.PORT || 8001),
  apiKey: process.env.MCP_API_KEY || "",

  // IMAP Accounts
  accounts: {
    onecom: {
      name: "one.com",
      host: process.env.IMAP_ONECOM_HOST || "imap.one.com",
      port: Number(process.env.IMAP_ONECOM_PORT || 993),
      user: process.env.IMAP_ONECOM_USER,
      password: process.env.IMAP_ONECOM_PASSWORD,
      tls: process.env.IMAP_ONECOM_TLS !== "false",
      signature: process.env.SIGNATURE_ONECOM,
      // Sent folder for SMTP-sent copies (IMAP APPEND). Unset = no copy saved.
      sentFolder: process.env.IMAP_ONECOM_SENT_FOLDER,
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_ONECOM_HOST || "send.one.com",
        port: Number(process.env.SMTP_ONECOM_PORT || 465),
        secure: process.env.SMTP_ONECOM_SECURE !== "false", // true for 465, false for 587
      },
    },
    gmx: {
      name: "GMX",
      host: process.env.IMAP_GMX_HOST || "imap.gmx.net",
      port: Number(process.env.IMAP_GMX_PORT || 993),
      user: process.env.IMAP_GMX_USER,
      password: process.env.IMAP_GMX_PASSWORD,
      tls: process.env.IMAP_GMX_TLS !== "false",
      sentFolder: process.env.IMAP_GMX_SENT_FOLDER,
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_GMX_HOST || "mail.gmx.net",
        port: Number(process.env.SMTP_GMX_PORT || 465),
        secure: process.env.SMTP_GMX_SECURE !== "false",
      },
    },
    gmail: {
      name: "Gmail",
      host: process.env.IMAP_GMAIL_HOST || "imap.gmail.com",
      port: Number(process.env.IMAP_GMAIL_PORT || 993),
      user: process.env.IMAP_GMAIL_USER,
      password: process.env.IMAP_GMAIL_PASSWORD,
      tls: process.env.IMAP_GMAIL_TLS !== "false",
      // Leave unset: Gmail SMTP auto-saves to "Sent Mail" — an APPEND would duplicate.
      sentFolder: process.env.IMAP_GMAIL_SENT_FOLDER,
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_GMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_GMAIL_PORT || 465),
        secure: process.env.SMTP_GMAIL_SECURE !== "false",
      },
    },
    iserv: {
      name: "IServ BS:WI",
      host: process.env.IMAP_ISERV_HOST || "imap.mail.schuldock.de",
      port: Number(process.env.IMAP_ISERV_PORT || 993),
      user: process.env.IMAP_ISERV_USER,
      password: process.env.IMAP_ISERV_PASSWORD,
      tls: process.env.IMAP_ISERV_TLS !== "false",
      // IServ SMTP saves no Sent copy; APPEND to the server Sent folder so sent mail
      // stays verifiable via IMAP/MCP. IServ uses slash-notation (INBOX/Sent), NOT
      // one.com's dot-notation (INBOX.Sent). Override via IMAP_ISERV_SENT_FOLDER.
      sentFolder: process.env.IMAP_ISERV_SENT_FOLDER || "INBOX/Sent",
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_ISERV_HOST || "smtp.mail.schuldock.de",
        port: Number(process.env.SMTP_ISERV_PORT || 587),
        secure: process.env.SMTP_ISERV_SECURE === "true", // false for STARTTLS on 587
      },
    },
    ms365: {
      name: "MS365 BS:WI",
      host: process.env.IMAP_MS365_HOST || "outlook.office365.com",
      port: Number(process.env.IMAP_MS365_PORT || 993),
      user: process.env.IMAP_MS365_USER,
      password: process.env.IMAP_MS365_PASSWORD,
      tls: process.env.IMAP_MS365_TLS !== "false",
      sentFolder: process.env.IMAP_MS365_SENT_FOLDER,
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_MS365_HOST || "smtp.office365.com",
        port: Number(process.env.SMTP_MS365_PORT || 587),
        secure: process.env.SMTP_MS365_SECURE === "true", // false for STARTTLS on 587
      },
    },
    post: {
      name: "one.com (post)",
      host: process.env.IMAP_POST_HOST || "imap.one.com",
      port: Number(process.env.IMAP_POST_PORT || 993),
      user: process.env.IMAP_POST_USER,
      password: process.env.IMAP_POST_PASSWORD,
      tls: process.env.IMAP_POST_TLS !== "false",
      signature: process.env.SIGNATURE_POST,
      // Business mailbox: save SMTP-sent copies to the server Sent folder so they
      // stay verifiable via IMAP/MCP (one.com SMTP does NOT auto-save). Folder
      // INBOX.Sent created 12.06.2026; override via IMAP_POST_SENT_FOLDER.
      sentFolder: process.env.IMAP_POST_SENT_FOLDER || "INBOX.Sent",
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_POST_HOST || "send.one.com",
        port: Number(process.env.SMTP_POST_PORT || 465),
        secure: process.env.SMTP_POST_SECURE !== "false",
      },
    },
  },
};

// Get configured accounts (only those with credentials)
export function getConfiguredAccounts() {
  return Object.entries(config.accounts)
    .filter(([_, acc]) => acc.user && acc.password)
    .map(([key, acc]) => ({ key, ...acc }));
}
