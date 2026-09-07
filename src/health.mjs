/**
 * /health und /version fuer imap-mcp.
 *
 * Duenner Adapter. Die Logik liegt in ./vendor/ — bytegleiche Kopie von
 * mcp-servers/_common/src/, weil imap-mcp als Git-Submodul deployt wird und
 * der Standalone-Clone auf dem Server kein _common als Sibling hat (Task g6f).
 * Aktualisieren mit: bash mcp-servers/sync-common-copies.sh
 *
 * /health macht seit 07.09.2026 einen ECHTEN MCP-Roundtrip gegen den eigenen
 * /mcp-Pfad und meldet ihn im Feld `mcp`. Der HTTP-Status bleibt dabei immer
 * 200: Docker und Traefik sollen den Dienst NICHT aus dem Routing nehmen,
 * Alarm schlaegt health-check.sh, das den Body liest.
 */
import { createHealthHandler, createVersionHandler } from "./vendor/health.mjs";
import { createMcpSelfCheck, deriveSelfCheckKey } from "./vendor/mcp-selfcheck.mjs";

const VERSION = "1.0.0";

const selfCheck = createMcpSelfCheck({
  port: Number(process.env.PORT || 8001),
  key: deriveSelfCheckKey(),
});

export const healthHandler = createHealthHandler({
  service: "imap-mcp",
  version: VERSION,
  selfCheck,
});

export const versionHandler = createVersionHandler({
  service: "imap-mcp",
  version: VERSION,
});
