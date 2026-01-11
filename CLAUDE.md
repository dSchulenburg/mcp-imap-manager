# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Model Context Protocol (MCP) server that provides IMAP email management capabilities. The server is built with Node.js/Express and uses the MCP SDK to expose IMAP operations as MCP tools. It supports multiple email accounts (one.com, GMX, Gmail) and can be deployed standalone or behind Traefik reverse proxy with automatic HTTPS.

## Architecture

### Core Components

- **src/server.mjs**: Main server file that:
  - Registers 7 MCP tools for IMAP operations (list accounts, folders, emails; move, delete operations)
  - Provides HTTP endpoints for health checks, testing, and account status
  - Uses StreamableHTTPServerTransport for MCP protocol communication
  - Manages persistent IMAP connections with automatic reconnection

- **src/config.mjs**: Environment variable loader for IMAP account credentials and server settings

### MCP Tools Registered

1. **imap_list_accounts**: List all configured IMAP accounts and their connection status
2. **imap_list_folders**: List all folders/mailboxes for a specific account
3. **imap_list_emails**: List emails in a folder with optional search criteria (from, subject, since, before)
4. **imap_move_email**: Move a single email by UID to a target folder
5. **imap_move_by_message_id**: Move email by Message-ID header (more reliable across sessions)
6. **imap_delete_email**: Permanently delete an email by UID
7. **imap_bulk_move**: Move multiple emails at once (by UIDs or Message-IDs)

### HTTP Endpoints

- `GET /health`: Health check (returns OK/status)
- `GET /version`: Version and runtime info
- `GET /accounts`: List all configured accounts
- `GET /test/:account`: Test connection to a specific account
- `POST /mcp`: MCP protocol endpoint (Streamable HTTP transport, API key protected)

## Development Commands

### Local Development

Start the server locally (requires .env file):
```bash
npm install
npm run dev
```

Access at: http://127.0.0.1:8001

### Docker Development

Build and run with Docker Compose (local, no Traefik):
```bash
docker-compose up -d --build
```

View logs:
```bash
docker logs imap-mcp -f
```

Stop:
```bash
docker-compose down
```

### Production Deployment

Deploy with Traefik integration (requires external `proxy` network):
```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

Access via: https://mcp-imap.dirk-schulenburg.net

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

**Server Settings:**
- `PORT`: Server port (default: 8001)
- `MCP_API_KEY`: Optional API key for securing /mcp endpoint

**IMAP Account 1: one.com**
- `IMAP_ONECOM_HOST`: IMAP server hostname (default: imap.one.com)
- `IMAP_ONECOM_PORT`: IMAP port (default: 993)
- `IMAP_ONECOM_USER`: Email address
- `IMAP_ONECOM_PASSWORD`: Password or app password
- `IMAP_ONECOM_TLS`: Enable TLS (default: true)

**IMAP Account 2: GMX**
- `IMAP_GMX_HOST`: IMAP server hostname (default: imap.gmx.net)
- `IMAP_GMX_PORT`: IMAP port (default: 993)
- `IMAP_GMX_USER`: Email address
- `IMAP_GMX_PASSWORD`: App password
- `IMAP_GMX_TLS`: Enable TLS (default: true)

**IMAP Account 3: Gmail (optional)**
- `IMAP_GMAIL_HOST`: IMAP server hostname (default: imap.gmail.com)
- `IMAP_GMAIL_PORT`: IMAP port (default: 993)
- `IMAP_GMAIL_USER`: Gmail address
- `IMAP_GMAIL_PASSWORD`: App password (requires 2FA enabled)
- `IMAP_GMAIL_TLS`: Enable TLS (default: true)

### App Password Setup

**GMX:**
1. Go to GMX Settings → Security → Two-Factor Authentication
2. Enable 2FA if not already enabled
3. Create App Password for "Email"

**Gmail:**
1. Enable 2-Factor Authentication in Google Account
2. Go to Security → App Passwords
3. Create new app password for "Mail"

**one.com:**
- Use your regular email password (or create app-specific if available)

## Testing

### Manual Testing

Health check:
```bash
curl http://127.0.0.1:8001/health
```

List configured accounts:
```bash
curl http://127.0.0.1:8001/accounts
```

Test specific account connection:
```bash
curl http://127.0.0.1:8001/test/onecom
curl http://127.0.0.1:8001/test/gmx
```

### MCP Tool Testing via curl

List folders:
```bash
curl -X POST http://127.0.0.1:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imap_list_folders","arguments":{"account":"onecom"}}}'
```

List emails in INBOX:
```bash
curl -X POST http://127.0.0.1:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imap_list_emails","arguments":{"account":"onecom","folder":"INBOX","limit":10}}}'
```

## IMAP Operations Details

### Folder Path Format

- Use dot notation for nested folders: `INBOX.Archiv.2024`
- one.com uses dot-separated paths
- GMX/Gmail may use slash-separated paths (handled automatically)

### Email UIDs vs Message-IDs

- **UID**: Unique within a mailbox session, faster but may change
- **Message-ID**: Globally unique header, more reliable for cross-session operations

### Move Operation

Internally performs:
1. COPY email to target folder
2. Mark original as \Deleted
3. EXPUNGE to remove deleted emails

### Bulk Operations

The `imap_bulk_move` tool supports:
- Moving up to 100 emails at once
- Can use either UIDs or Message-IDs
- Atomic operation (all or nothing)

## Integration with n8n

This MCP server is designed to work with n8n workflows for email processing:

1. n8n workflow triggers email classification
2. Classification result determines target folder
3. n8n calls IMAP MCP to move email to target folder
4. Cleanup workflow deletes old emails from spam/newsletter folders

### n8n HTTP Request Node Configuration

```
Method: POST
URL: http://imap-mcp:8001/mcp (or https://mcp-imap.dirk-schulenburg.net/mcp)
Headers:
  Content-Type: application/json
  X-API-Key: {{$env.MCP_API_KEY}}
Body:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "imap_move_email",
    "arguments": {
      "account": "onecom",
      "sourceFolder": "INBOX",
      "targetFolder": "INBOX._archiv.newsletter",
      "uid": {{$json.emailUid}}
    }
  }
}
```

## Common Operations

### Rebuilding After Code Changes

```bash
docker-compose up -d --build
```

### Viewing Logs

```bash
docker logs imap-mcp -f
```

### Checking Account Status

```bash
curl http://127.0.0.1:8001/accounts
```

## Deployment Notes

### Traefik Integration

Production deployment (docker-compose.prod.yml) expects:
- External `proxy` network created beforehand: `docker network create proxy`
- Traefik running with Let's Encrypt configured
- Domain configured: mcp-imap.dirk-schulenburg.net

### Security

- `/mcp` endpoint protected by MCP_API_KEY if set
- IMAP credentials never exposed in responses
- TLS enabled by default for all IMAP connections
- Non-root user in Docker container

### Connection Management

- Connections are established on-demand
- Idle connections are kept alive for performance
- Automatic reconnection on connection loss
- Graceful shutdown closes all connections
