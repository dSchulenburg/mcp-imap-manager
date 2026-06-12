import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAttachments,
  ensureReplyPrefix,
  buildReferences,
  buildQuoteText,
  pickReplyRecipients,
  parseWhitelistDirs,
  resolveSentTarget,
} from "../src/email-helpers.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "imap-mcp-test-"));
const allowedDir = join(sandbox, "allowed");
const otherDir = join(sandbox, "other");
mkdirSync(allowedDir);
mkdirSync(otherDir);
const allowedFile = join(allowedDir, "doc.pdf");
const otherFile = join(otherDir, "secret.txt");
writeFileSync(allowedFile, "%PDF-1.4 dummy");
writeFileSync(otherFile, "secrets");

test("ensureReplyPrefix adds AW: when missing", () => {
  assert.equal(ensureReplyPrefix("Bewerbung"), "AW: Bewerbung");
});

test("ensureReplyPrefix preserves existing Re:/AW: prefix", () => {
  assert.equal(ensureReplyPrefix("Re: Hello"), "Re: Hello");
  assert.equal(ensureReplyPrefix("AW: Test"), "AW: Test");
  assert.equal(ensureReplyPrefix("ANTWORT: Foo"), "ANTWORT: Foo");
});

test("ensureReplyPrefix handles empty subject", () => {
  assert.equal(ensureReplyPrefix(""), "AW: ");
  assert.equal(ensureReplyPrefix(undefined), "AW: ");
});

test("buildReferences appends original Message-ID at end", () => {
  const refs = buildReferences("<a@x> <b@x>", "<c@x>");
  assert.equal(refs, "<a@x> <b@x> <c@x>");
});

test("buildReferences handles no prior references", () => {
  assert.equal(buildReferences(null, "<c@x>"), "<c@x>");
});

test("buildReferences avoids duplicating an already-included message-id", () => {
  const refs = buildReferences("<a@x> <c@x>", "<c@x>");
  assert.equal(refs, "<a@x> <c@x>");
});

test("buildReferences accepts array references", () => {
  const refs = buildReferences(["<a@x>", "<b@x>"], "<c@x>");
  assert.equal(refs, "<a@x> <b@x> <c@x>");
});

test("buildAttachments rejects path with empty whitelist", () => {
  assert.throws(
    () => buildAttachments([{ filename: "x.pdf", path: allowedFile }], []),
    /not under ATTACHMENT_WHITELIST_DIRS/
  );
});

test("buildAttachments rejects path outside whitelist", () => {
  assert.throws(
    () => buildAttachments([{ filename: "secret.txt", path: otherFile }], [allowedDir]),
    /not under ATTACHMENT_WHITELIST_DIRS/
  );
});

test("buildAttachments allows path inside whitelist", () => {
  const out = buildAttachments([{ filename: "doc.pdf", path: allowedFile }], [allowedDir]);
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, "doc.pdf");
  assert.equal(out[0].path, allowedFile);
});

test("buildAttachments rejects relative path", () => {
  assert.throws(
    () => buildAttachments([{ filename: "x.pdf", path: "./relative.pdf" }], [allowedDir]),
    /must be absolute/
  );
});

test("buildAttachments rejects both path and content", () => {
  assert.throws(
    () => buildAttachments([{ filename: "x.pdf", path: allowedFile, content: "abc" }], [allowedDir]),
    /not both/
  );
});

test("buildAttachments rejects neither path nor content", () => {
  assert.throws(
    () => buildAttachments([{ filename: "x.pdf" }], [allowedDir]),
    /must provide 'path' or 'content'/
  );
});

test("buildAttachments rejects missing filename", () => {
  assert.throws(
    () => buildAttachments([{ path: allowedFile }], [allowedDir]),
    /filename is required/
  );
});

test("buildAttachments accepts base64 content with no whitelist", () => {
  const b64 = Buffer.from("hello").toString("base64");
  const out = buildAttachments([{ filename: "hello.txt", content: b64 }], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, "hello.txt");
  assert.equal(out[0].content.toString(), "hello");
});

test("buildAttachments returns undefined for empty input", () => {
  assert.equal(buildAttachments(undefined, []), undefined);
  assert.equal(buildAttachments([], []), undefined);
});

test("buildAttachments rejects directory path even if inside whitelist", () => {
  assert.throws(
    () => buildAttachments([{ filename: "dir", path: allowedDir }], [allowedDir]),
    /not a regular file/
  );
});

test("pickReplyRecipients (no replyAll) targets only the original sender", () => {
  const parsed = {
    from: { value: [{ address: "alice@example.com" }], text: "Alice <alice@example.com>" },
    to: { value: [{ address: "bob@example.com" }] },
    cc: { value: [{ address: "carol@example.com" }] },
  };
  const result = pickReplyRecipients(parsed, { replyAll: false, selfAddress: "bob@example.com" });
  assert.equal(result.to, "alice@example.com");
  assert.equal(result.cc, null);
});

test("pickReplyRecipients (replyAll) includes from + to + cc, excluding self", () => {
  const parsed = {
    from: { value: [{ address: "alice@example.com" }] },
    to: { value: [{ address: "bob@example.com" }, { address: "dirk@bs-wi.de" }] },
    cc: { value: [{ address: "carol@example.com" }] },
  };
  const result = pickReplyRecipients(parsed, { replyAll: true, selfAddress: "dirk@bs-wi.de" });
  assert.equal(result.to, "alice@example.com, bob@example.com");
  assert.equal(result.cc, "carol@example.com");
});

test("pickReplyRecipients deduplicates addresses (case-insensitive)", () => {
  const parsed = {
    from: { value: [{ address: "Alice@example.com" }] },
    to: { value: [{ address: "alice@example.com" }, { address: "bob@example.com" }] },
    cc: { value: [{ address: "BOB@example.com" }] },
  };
  const result = pickReplyRecipients(parsed, { replyAll: true, selfAddress: "" });
  assert.equal(result.to, "Alice@example.com, bob@example.com");
  assert.equal(result.cc, null);
});

test("buildQuoteText produces > -prefixed lines", () => {
  const parsed = {
    date: new Date("2026-04-29T10:00:00Z"),
    from: { text: "Alice <alice@example.com>" },
    text: "Hi Dirk,\n\nthanks for the offer.\n",
  };
  const out = buildQuoteText(parsed);
  assert.match(out, /Am .* schrieb Alice <alice@example\.com>:/);
  assert.match(out, /^> Hi Dirk,$/m);
  assert.match(out, /^> thanks for the offer\.$/m);
});

test("parseWhitelistDirs handles empty/missing env", () => {
  assert.deepEqual(parseWhitelistDirs(""), []);
  assert.deepEqual(parseWhitelistDirs(undefined), []);
});

test("parseWhitelistDirs splits and trims", () => {
  const dirs = parseWhitelistDirs(`${allowedDir} , ${otherDir}`);
  assert.equal(dirs.length, 2);
  // Both dirs exist, should be realpath-resolved (fs.realpath returns canonical case)
  assert.equal(dirs[0].toLowerCase(), allowedDir.toLowerCase());
  assert.equal(dirs[1].toLowerCase(), otherDir.toLowerCase());
});

test("resolveSentTarget saves to configured folder by default", () => {
  const r = resolveSentTarget({ sentFolder: "INBOX.Sent" });
  assert.deepEqual(r, { save: true, folder: "INBOX.Sent" });
});

test("resolveSentTarget does not save when no folder configured", () => {
  assert.deepEqual(resolveSentTarget({}), { save: false, folder: null });
  assert.deepEqual(resolveSentTarget(undefined), { save: false, folder: null });
});

test("resolveSentTarget: explicit saveToSent=false overrides configured folder", () => {
  const r = resolveSentTarget({ sentFolder: "INBOX.Sent" }, { saveToSent: false });
  assert.deepEqual(r, { save: false, folder: null });
});

test("resolveSentTarget: explicit saveToSent=true falls back to INBOX.Sent", () => {
  const r = resolveSentTarget({}, { saveToSent: true });
  assert.deepEqual(r, { save: true, folder: "INBOX.Sent" });
});

test("resolveSentTarget: sentFolder arg overrides account default", () => {
  const r = resolveSentTarget({ sentFolder: "INBOX.Sent" }, { sentFolder: "INBOX.Gesendet" });
  assert.deepEqual(r, { save: true, folder: "INBOX.Gesendet" });
});
