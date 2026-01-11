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
    },
    gmx: {
      name: "GMX",
      host: process.env.IMAP_GMX_HOST || "imap.gmx.net",
      port: Number(process.env.IMAP_GMX_PORT || 993),
      user: process.env.IMAP_GMX_USER,
      password: process.env.IMAP_GMX_PASSWORD,
      tls: process.env.IMAP_GMX_TLS !== "false",
    },
    gmail: {
      name: "Gmail",
      host: process.env.IMAP_GMAIL_HOST || "imap.gmail.com",
      port: Number(process.env.IMAP_GMAIL_PORT || 993),
      user: process.env.IMAP_GMAIL_USER,
      password: process.env.IMAP_GMAIL_PASSWORD,
      tls: process.env.IMAP_GMAIL_TLS !== "false",
    },
  },
};

// Get configured accounts (only those with credentials)
export function getConfiguredAccounts() {
  return Object.entries(config.accounts)
    .filter(([_, acc]) => acc.user && acc.password)
    .map(([key, acc]) => ({ key, ...acc }));
}
