import rateLimit from 'express-rate-limit';

// Pfade mit eigenem Limiter (mcpLimiter, healthLimiter) nimmt der allgemeine Limiter aus.
// Sonst zaehlt er sie mit: 100 Requests / 15 min waren fuer einen Collector-Lauf
// (3 Listen + 75 Reads + 75 Moves) zu wenig, und die letzten ~50 Moves bekamen 429,
// obwohl /mcp mit ~17/min weit unter seinen 30/min lag (gemessen 12.09.2026).
export function hasOwnLimiter(path) {
  return path === "/mcp" || path.startsWith("/mcp/") || path === "/health" || path.startsWith("/health/");
}

// Standard Rate Limiter für alle uebrigen Requests
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 100, // max 100 Requests pro IP pro 15 Min
  skip: (req) => hasOwnLimiter(req.path),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: '15 minutes'
  }
});

// Strengerer Limiter für MCP/API Endpoints
export const mcpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 Minute
  max: 30, // max 30 Requests pro IP pro Minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Rate limit exceeded. Max 30 requests per minute.'
    },
    id: null
  }
});

// Lockerer Limiter für Health-Checks
export const healthLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 Minute
  max: 60, // max 60 Requests pro IP pro Minute (für Monitoring)
  standardHeaders: true,
  legacyHeaders: false,
});
