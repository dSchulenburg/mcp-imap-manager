# Node 22 statt 20 (20.09.2026): Node 20 "Iron" ist seit 30.04.2026 aus der Wartung
# und bekommt keine Sicherheitspatches der Laufzeit mehr. Die Alpine-Basis wird
# weiter gepflegt, die Node-Binaerdatei nicht.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8001/health || exit 1

# Start server
CMD ["node", "src/server.mjs"]
