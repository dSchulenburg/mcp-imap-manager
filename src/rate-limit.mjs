import rateLimit from 'express-rate-limit';

// Standard Rate Limiter für alle Requests
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 100, // max 100 Requests pro IP pro 15 Min
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
