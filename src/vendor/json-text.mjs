/**
 * Transportsichere Tool-Antworten: U+2028 / U+2029 maskieren.
 *
 * JSON.stringify laesst LINE SEPARATOR (U+2028) und PARAGRAPH SEPARATOR
 * (U+2029) roh stehen - beides ist gueltiges JSON. In JavaScript und in
 * zeilenbasierten Parsern sind es aber echte Zeilenenden, und der SSE-Rahmen
 * des StreamableHTTP-Transports wird genau dort zerschnitten. Der Server
 * antwortet HTTP 200, das Log bleibt still, der Client meldet
 * "Invalid response format" - und zwar nur fuer den einen Datensatz, der das
 * Zeichen traegt (gemessen 04./07.09.2026 an einer IServ-Mail in imap-mcp und
 * an einer Task-Notiz im Taskboard).
 *
 * Betroffen ist jeder Server, der fremden Text durchreicht: Mails, Notizen,
 * Kursinhalte, Chatnachrichten, Kartentexte. Webmail- und Rich-Text-Editoren
 * setzen die Zeichen als weiche Umbrueche.
 *
 * Zwei Einsatzformen:
 *   toJsonText(value)     - Ersatz fuer JSON.stringify(value, null, 2)
 *   hardenServer(mcp)     - EIN Aufruf nach `new McpServer(...)`: wickelt jede
 *                           spaeter registrierte Tool-Callback ein und maskiert
 *                           alle Text-Inhalte des Ergebnisses (auch Markdown,
 *                           nicht nur JSON) sowie die Meldung geworfener Fehler.
 *
 * Die Zeichenklasse ist aus Zahlencodes gebaut statt als Regex-Literal notiert:
 * ein rohes U+2028 in dieser Datei waere selbst ein Zeilenende und zerlegte die
 * Quelle (SyntaxError im Literal) - genau der Mechanismus, um den es geht.
 *
 * Kanon: mcp-servers/_common/src/json-text.mjs. Die Kopien in den
 * vendor-Ordnern der Server pflegt sync-common-copies.sh; die CommonJS-Fassung
 * im Taskboard (taskboard/mcp/json-text.js) ist der Ursprung dieser Datei.
 */

const UNICODE_SEPARATORS = new RegExp(
  '[' + String.fromCharCode(0x2028, 0x2029) + ']',
  'g'
);

/** Maskiert U+2028/U+2029 in beliebigem Text als sechsstellige Backslash-u-Escapes. */
export function escapeSeparators(text) {
  return String(text).replace(
    UNICODE_SEPARATORS,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16)
  );
}

/** Wie JSON.stringify(value, null, 2), aber transportsicher. */
export function toJsonText(value) {
  return escapeSeparators(JSON.stringify(value, null, 2));
}

/**
 * Maskiert die Text-Inhalte eines Tool-Ergebnisses ({ content: [...] }).
 * Andere Inhaltstypen (image, resource) und alle uebrigen Felder bleiben
 * unangetastet; ein Ergebnis ohne content-Liste kommt unveraendert zurueck.
 */
export function hardenToolResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((item) =>
      item && item.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: escapeSeparators(item.text) }
        : item
    ),
  };
}

/** Wickelt eine Tool-Callback ein: Ergebnis und Fehlermeldung werden maskiert. */
export function hardenToolCallback(callback) {
  return async function hardened(...args) {
    try {
      return hardenToolResult(await callback.apply(this, args));
    } catch (err) {
      if (err && typeof err.message === 'string') {
        err.message = escapeSeparators(err.message);
      }
      throw err;
    }
  };
}

/**
 * Patcht registerTool() und tool() einer McpServer-Instanz, so dass jede
 * danach registrierte Callback durch hardenToolCallback laeuft. Gibt die
 * Instanz zurueck, damit sich der Aufruf in eine Zuweisung einbetten laesst:
 *
 *   const mcp = hardenServer(new McpServer(info));
 *
 * Der Server-Code selbst bleibt unveraendert - es ist bewusst der eine
 * Dispatch-Punkt, damit nicht jeder Handler einzeln angefasst werden muss.
 */
export function hardenServer(mcp) {
  for (const method of ['registerTool', 'tool']) {
    const original = mcp[method];
    if (typeof original !== 'function') continue;
    mcp[method] = function (...args) {
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        args[last] = hardenToolCallback(args[last]);
      }
      return original.apply(this, args);
    };
  }
  return mcp;
}
