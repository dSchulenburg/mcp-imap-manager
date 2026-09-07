# vendor/ — Kopien aus `_common/src/`

**Nicht hier bearbeiten.** Kanon ist `mcp-servers/_common/src/`; die Tests dazu
liegen in `mcp-servers/_common/test/`.

Dieser Server erreicht `@mcp/common` nicht (Submodul oder Docker-Build-Context
ohne `_common`), deshalb die Kopie. Nach jeder Aenderung am Kanon:

    bash mcp-servers/sync-common-copies.sh

Pruefen ohne zu schreiben: `bash mcp-servers/sync-common-copies.sh --check`
