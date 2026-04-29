import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from "path";
import { realpathSync, statSync } from "fs";

export function parseWhitelistDirs(env = process.env.ATTACHMENT_WHITELIST_DIRS) {
  const raw = env || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((dir) => {
      try {
        return realpathSync(dir);
      } catch {
        return pathResolve(dir);
      }
    });
}

export function isPathAllowed(absPath, whitelist) {
  if (whitelist.length === 0) return false;
  let real;
  try {
    real = realpathSync(absPath);
  } catch (err) {
    throw new Error(`Attachment path not accessible: ${absPath} (${err.code || err.message})`);
  }
  const st = statSync(real);
  if (!st.isFile()) {
    throw new Error(`Attachment path is not a regular file: ${absPath}`);
  }
  const sep = process.platform === "win32" ? "\\" : "/";
  return whitelist.some((root) => real === root || real.startsWith(root + sep));
}

export function buildAttachments(attachments, whitelist = parseWhitelistDirs()) {
  if (!attachments || attachments.length === 0) return undefined;

  const out = [];

  for (const [idx, a] of attachments.entries()) {
    if (!a.filename) {
      throw new Error(`attachments[${idx}]: filename is required`);
    }
    const hasPath = typeof a.path === "string" && a.path.length > 0;
    const hasContent = typeof a.content === "string" && a.content.length > 0;

    if (hasPath && hasContent) {
      throw new Error(`attachments[${idx}]: provide either 'path' or 'content', not both`);
    }
    if (!hasPath && !hasContent) {
      throw new Error(`attachments[${idx}]: must provide 'path' or 'content'`);
    }

    if (hasPath) {
      if (!pathIsAbsolute(a.path)) {
        throw new Error(`attachments[${idx}]: path must be absolute (got '${a.path}')`);
      }
      if (!isPathAllowed(a.path, whitelist)) {
        throw new Error(
          `attachments[${idx}]: path '${a.path}' is not under ATTACHMENT_WHITELIST_DIRS (configured: ${whitelist.length === 0 ? "<none>" : whitelist.join(", ")})`
        );
      }
      out.push({
        filename: a.filename,
        path: a.path,
        ...(a.contentType ? { contentType: a.contentType } : {}),
      });
    } else {
      out.push({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
        ...(a.contentType ? { contentType: a.contentType } : {}),
      });
    }
  }

  return out;
}

export function ensureReplyPrefix(subject) {
  const s = (subject || "").trim();
  if (/^(re|aw|antw|antwort)\s*:/i.test(s)) return s;
  return `AW: ${s}`;
}

export function buildReferences(originalReferences, originalMessageId) {
  const refs = [];
  if (originalReferences) {
    const list = Array.isArray(originalReferences)
      ? originalReferences
      : String(originalReferences).split(/\s+/).filter(Boolean);
    refs.push(...list);
  }
  if (originalMessageId && !refs.includes(originalMessageId)) {
    refs.push(originalMessageId);
  }
  return refs.join(" ");
}

export function buildQuoteText(parsed) {
  const date = parsed.date ? parsed.date.toLocaleString("de-DE") : "";
  const from = parsed.from?.text || "";
  const header = `\n\nAm ${date} schrieb ${from}:\n`;
  const body = (parsed.text || "").split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  return header + body;
}

export function buildQuoteHtml(parsed) {
  const date = parsed.date ? parsed.date.toLocaleString("de-DE") : "";
  const from = (parsed.from?.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inner = parsed.html || (parsed.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  return `<br><br><div>Am ${date} schrieb ${from}:</div><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`;
}

export function pickReplyRecipients(parsed, { replyAll, selfAddress }) {
  const self = (selfAddress || "").toLowerCase();
  if (!replyAll) {
    const to = parsed.from?.value?.[0]?.address || parsed.from?.text || "";
    return { to, cc: null };
  }
  const fromList = (parsed.from?.value || []).map((v) => v.address).filter(Boolean);
  const toList = (parsed.to?.value || []).map((v) => v.address).filter(Boolean);
  const ccList = (parsed.cc?.value || []).map((v) => v.address).filter(Boolean);
  const seen = new Set();
  const dedup = (arr) => arr.filter((a) => {
    const k = a.toLowerCase();
    if (k === self || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const primary = dedup([...fromList, ...toList]);
  const ccRest = dedup(ccList);
  return {
    to: primary.join(", "),
    cc: ccRest.length > 0 ? ccRest.join(", ") : null,
  };
}
