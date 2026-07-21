/**
 * Error thrown by the YAML parser. Carries the source name and the 1-based
 * line (and column, when known) so callers and the CLI can point users at the
 * exact spot in their portler.yml.
 */
export class YamlParseError extends Error {
  readonly source: string;
  readonly line: number;
  readonly column?: number;

  constructor(source: string, line: number, message: string, column?: number) {
    const location = column === undefined ? `${source}:${line}` : `${source}:${line}:${column}`;
    super(`${location}: ${message}`);
    this.name = 'YamlParseError';
    this.source = source;
    this.line = line;
    this.column = column;
  }
}
