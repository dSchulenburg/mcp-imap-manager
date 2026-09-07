/**
 * Geteilter /health- und /version-Handler fuer die MCP-Server.
 *
 * Loest neun auseinandergelaufene Kopien von src/health.mjs ab (jede mit
 * eigener Pruefsumme, pinnwand-mcp war auf 208 Bytes eingedampft ohne Version
 * und ohne timestamp).
 *
 * ZUSAGE: Der HTTP-Status ist IMMER 200 — auch bei mcp: "fail". Der Befund
 * steht im Body, nicht im Status. Docker-Healthcheck und Traefik sehen also
 * keinen Unterschied und nehmen den Dienst nicht aus dem Routing; Alarm
 * schlaegt health-check.sh, das den Body liest. "Melden, nicht abschalten."
 */

export function createHealthHandler({ service, version, selfCheck, extra = {} }) {
  return async function healthHandler(_req, res) {
    let probe;
    if (!selfCheck) {
      probe = { mcp: 'unconfigured', reason: 'kein Selfcheck verdrahtet' };
    } else {
      try {
        probe = await selfCheck();
      } catch (err) {
        probe = { mcp: 'fail', reason: err?.message || String(err) };
      }
    }

    // extra darf eine Funktion sein: moodle-mcp meldet auth: getAuthStatus(),
    // das muss pro Request neu ausgewertet werden statt beim Serverstart
    // einzufrieren.
    const zusatz = typeof extra === 'function' ? extra() : extra;

    res.json({
      status: 'ok',
      service,
      version,
      ...zusatz,
      ...probe,
      timestamp: new Date().toISOString(),
    });
  };
}

export function createVersionHandler({ service, version, extra = {} }) {
  return function versionHandler(_req, res) {
    res.json({
      name: service,
      version,
      node: process.version,
      platform: process.platform,
      uptime: process.uptime(),
      ...extra,
    });
  };
}
