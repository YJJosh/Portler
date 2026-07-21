/**
 * Minimal block-style YAML writer for the plain objects Portler generates
 * (Kubernetes manifests). Supports nested maps, arrays, strings, numbers,
 * booleans, and null; strings that could be misread are quoted.
 */

const SAFE_PLAIN = /^[A-Za-z0-9_./@-][A-Za-z0-9_./@:+-]*$/;
const LOOKS_TYPED = /^(?:true|false|null|~|yes|no|on|off|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i;

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new Error(`cannot serialize ${typeof value} to YAML`);

  if (SAFE_PLAIN.test(value) && !LOOKS_TYPED.test(value) && !value.endsWith(':')) return value;
  // Double-quoted (JSON) style covers newlines, tabs, and other control
  // characters that single-quoted YAML cannot express.
  if (/[\x00-\x1f"\\]/.test(value)) return JSON.stringify(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object';
}

function writeValue(value: unknown, indent: number, lines: string[]): void {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${formatScalar(item)}`);
        continue;
      }

      // Render the item indented one level, then fold "- " into its first
      // line — the standard compact block-sequence layout.
      const itemLines: string[] = [];
      writeValue(item, indent + 2, itemLines);
      if (itemLines.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      itemLines[0] = `${pad}- ${itemLines[0]!.slice(indent + 2)}`;
      lines.push(...itemLines);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;

    if (isScalar(entry)) {
      lines.push(`${pad}${formatScalar(key)}: ${formatScalar(entry)}`);
    } else if (Array.isArray(entry) && entry.length === 0) {
      lines.push(`${pad}${formatScalar(key)}: []`);
    } else if (!Array.isArray(entry) && Object.keys(entry as object).length === 0) {
      lines.push(`${pad}${formatScalar(key)}: {}`);
    } else {
      lines.push(`${pad}${formatScalar(key)}:`);
      writeValue(entry, indent + 2, lines);
    }
  }
}

/** Serialize one document (a plain object) to block-style YAML. */
export function formatYaml(document: unknown): string {
  if (isScalar(document)) return `${formatScalar(document)}\n`;

  const lines: string[] = [];
  writeValue(document, 0, lines);
  return `${lines.join('\n')}\n`;
}

/** Serialize multiple documents into one `---`-separated YAML stream. */
export function formatYamlDocuments(documents: unknown[]): string {
  return documents.map((document) => `---\n${formatYaml(document)}`).join('');
}
