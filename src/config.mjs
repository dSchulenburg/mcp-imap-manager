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
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_GMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_GMAIL_PORT || 465),
        secure: process.env.SMTP_GMAIL_SECURE !== "false",
      },
    },
    iserv: {
      name: "IServ BS:WI",
      host: process.env.IMAP_ISERV_HOST || "imap.bs05.hibb.hamburg",
      port: Number(process.env.IMAP_ISERV_PORT || 993),
      user: process.env.IMAP_ISERV_USER,
      password: process.env.IMAP_ISERV_PASSWORD,
      tls: process.env.IMAP_ISERV_TLS !== "false",
      // SMTP Settings
      smtp: {
        host: process.env.SMTP_ISERV_HOST || "smtp.bs05.hibb.hamburg",
        port: Number(process.env.SMTP_ISERV_PORT || 587),
        secure: process.env.SMTP_ISERV_SECURE === "true", // false for STARTTLS on 587
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
