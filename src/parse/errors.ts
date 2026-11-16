/** `line` and `column` (when known) are 1-based. */
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
