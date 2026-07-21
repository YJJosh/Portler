/**
 * Hand-rolled indentation-based parser for the practical YAML subset that
 * portler.yml and Docker-Compose-style files use.
 *
 * Supported: nested mappings and block sequences (including mappings and
 * nested sequences inside `- ` items), inline [] / {} flow collections
 * (which may span multiple lines), single/double-quoted strings with escapes,
 * literal (|) and folded (>) block scalars with chomping indicators, quoted
 * keys, `#` comments, true/false/null/~, integer/float literals, and a
 * leading `---` document marker. Parse failures throw YamlParseError carrying
 * the source name and 1-based line (and column, where known).
 *
 * Deliberately not supported (throws a clear error instead of mis-parsing):
 * anchors/aliases (& and *), tags (!), multiple documents, complex (`? `)
 * keys, and tab indentation.
 */
import { YamlParseError } from './errors.ts';
import { findUnquoted, stripComment } from './scan.ts';
import { isObject } from '../util/guards.ts';
import type { UnknownMap } from '../types/index.ts';

interface ContentLine {
  indent: number;
  /** Comment-stripped content without the leading indent. */
  text: string;
  /** 1-based. */
  lineNumber: number;
}

interface QuotedString {
  value: string;
  /** Index just past the closing quote. */
  end: number;
}

function countIndent(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/**
 * Find the `:` that separates a mapping key from its value: the first
 * unquoted colon followed by whitespace or end-of-line. Colons inside quotes
 * or URLs (`http://...`) do not match.
 */
function findKeySeparator(text: string): number {
  return findUnquoted(text, (char, index) => {
    if (char !== ':') return false;
    const next = text[index + 1];
    return next === undefined || next === ' ' || next === '\t';
  });
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  'n': '\n',
  't': '\t',
  'r': '\r',
  '0': '\0',
  'b': '\b',
  'f': '\f',
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
};

/**
 * Read a quoted string starting at `start` (which must be a quote character).
 * Double quotes support backslash escapes (including \uXXXX); single quotes
 * support the doubled `''` escape. Returns null when the string never closes.
 */
function readQuotedString(text: string, start: number): QuotedString | null {
  const quote = text[start]!;
  let value = '';
  let index = start + 1;

  while (index < text.length) {
    const char = text[index]!;

    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        return { value, end: index + 1 };
      }
      value += char;
      index += 1;
      continue;
    }

    if (char === '"') return { value, end: index + 1 };

    if (char === '\\') {
      const escape = text[index + 1];
      if (escape === undefined) return null;

      if (escape === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      }

      const mapped = DOUBLE_QUOTE_ESCAPES[escape];
      // Tolerate unknown escapes by keeping them literally.
      value += mapped ?? `\\${escape}`;
      index += 2;
      continue;
    }

    value += char;
    index += 1;
  }

  return null;
}

/** Apply YAML 1.2 core typing rules to a plain (unquoted) scalar. */
function typedScalar(text: string): unknown {
  if (text === '') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (text === 'null' || text === 'Null' || text === 'NULL' || text === '~') return null;
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) || /^[+-]?\d+[eE][+-]?\d+$/.test(text)) {
    return Number.parseFloat(text);
  }
  return text;
}

/** Net `[`/`{` vs `]`/`}` bracket balance outside quotes, for multi-line flow. */
function flowDepthDelta(text: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
  }

  return depth;
}

/**
 * Assign without ever writing to the prototype chain, so hostile keys like
 * `__proto__` cannot pollute the parsed object.
 */
function defineKey(target: UnknownMap, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Fold the content lines of a `>` block scalar: consecutive content lines
 * join with a space, blank lines become newlines, and more-indented lines
 * keep their literal line breaks.
 */
function foldLines(lines: string[]): string {
  let output = '';
  let previousIsContent = false;
  let previousMoreIndented = false;

  for (const line of lines) {
    if (line === '') {
      output += '\n';
      previousIsContent = false;
      continue;
    }

    const moreIndented = line.startsWith(' ') || line.startsWith('\t');
    if (previousIsContent) output += moreIndented || previousMoreIndented ? '\n' : ' ';
    output += line;
    previousIsContent = true;
    previousMoreIndented = moreIndented;
  }

  return output;
}

/** Recursive-descent parser for inline `[...]` and `{...}` flow collections. */
class FlowParser {
  private readonly text: string;
  private readonly source: string;
  private readonly lineNumber: number;
  private readonly singleLine: boolean;
  private position = 0;

  constructor(text: string, source: string, lineNumber: number, singleLine: boolean) {
    this.text = text;
    this.source = source;
    this.lineNumber = lineNumber;
    this.singleLine = singleLine;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipSpaces();
    if (this.position < this.text.length) {
      this.fail(`unexpected content after the flow collection: "${this.remainder()}"`);
    }
    return value;
  }

  private remainder(): string {
    const rest = this.text.slice(this.position);
    return rest.length > 30 ? `${rest.slice(0, 30)}...` : rest;
  }

  private fail(message: string): never {
    // The column is only meaningful when the flow value sat on a single line;
    // multi-line flow collections are joined before parsing.
    const column = this.singleLine ? this.position + 1 : undefined;
    throw new YamlParseError(this.source, this.lineNumber, message, column);
  }

  private skipSpaces(): void {
    while (this.text[this.position] === ' ' || this.text[this.position] === '\t') this.position += 1;
  }

  private parseValue(): unknown {
    this.skipSpaces();
    const char = this.text[this.position];
    if (char === undefined) this.fail('unexpected end of flow collection');
    if (char === '[') return this.parseArray();
    if (char === '{') return this.parseObject();
    return this.parseScalar(false);
  }

  private parseArray(): unknown[] {
    const output: unknown[] = [];
    this.position += 1;
    this.skipSpaces();
    if (this.text[this.position] === ']') {
      this.position += 1;
      return output;
    }

    while (true) {
      output.push(this.parseValue());
      this.skipSpaces();
      const char = this.text[this.position];

      if (char === ',') {
        this.position += 1;
        this.skipSpaces();
        if (this.text[this.position] === ']') {
          this.position += 1;
          return output;
        }
        continue;
      }

      if (char === ']') {
        this.position += 1;
        return output;
      }

      this.fail(`expected "," or "]" in inline array, got "${this.remainder()}"`);
    }
  }

  private parseObject(): UnknownMap {
    const output: UnknownMap = {};
    this.position += 1;
    this.skipSpaces();
    if (this.text[this.position] === '}') {
      this.position += 1;
      return output;
    }

    while (true) {
      this.skipSpaces();
      const rawKey = this.parseScalar(true);
      if (rawKey === null || rawKey === '') this.fail('expected a key in inline object');
      const key = String(rawKey);
      if (Object.hasOwn(output, key)) this.fail(`duplicate key "${key}" in inline object`);

      this.skipSpaces();
      let value: unknown = null;
      if (this.text[this.position] === ':') {
        this.position += 1;
        value = this.parseValue();
        this.skipSpaces();
      }

      defineKey(output, key, value);
      const char = this.text[this.position];

      if (char === ',') {
        this.position += 1;
        this.skipSpaces();
        if (this.text[this.position] === '}') {
          this.position += 1;
          return output;
        }
        continue;
      }

      if (char === '}') {
        this.position += 1;
        return output;
      }

      this.fail(`expected "," or "}" in inline object, got "${this.remainder()}"`);
    }
  }

  private parseScalar(stopAtColon: boolean): unknown {
    this.skipSpaces();
    const start = this.position;
    const first = this.text[start];

    if (first === '"' || first === "'") {
      const quoted = readQuotedString(this.text, start);
      if (!quoted) this.fail(`unterminated ${first === '"' ? 'double' : 'single'}-quoted string`);
      this.position = quoted.end;
      return quoted.value;
    }

    let index = start;
    while (index < this.text.length) {
      const char = this.text[index]!;
      if (char === ',' || char === ']' || char === '}' || char === '[' || char === '{') break;
      if (stopAtColon && char === ':') break;
      index += 1;
    }

    const raw = this.text.slice(start, index).trim();
    this.position = index;

    if (raw.startsWith('&') || raw.startsWith('*')) this.fail('YAML anchors and aliases (& / *) are not supported');
    if (raw.startsWith('!')) this.fail('YAML tags (!...) are not supported');
    return typedScalar(raw);
  }
}

/** Indentation-based parser over the document's lines. */
class YamlParser {
  private readonly lines: string[];
  private readonly source: string;
  private index = 0;

  constructor(text: string, source: string) {
    this.lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    this.source = source;
  }

  parse(): UnknownMap {
    let first = this.peek();
    if (first && first.text === '---') {
      this.index += 1;
      first = this.peek();
    }
    if (!first) return {};
    if (first.text === '---') this.fail(first.lineNumber, 'multiple YAML documents are not supported');

    const value = this.parseNode();

    const trailing = this.peek();
    if (trailing) {
      if (trailing.text === '...') {
        this.index += 1;
        const after = this.peek();
        if (after) this.fail(after.lineNumber, 'content after the "..." end-of-document marker');
      } else if (trailing.text === '---') {
        this.fail(trailing.lineNumber, 'multiple YAML documents are not supported');
      } else {
        this.fail(trailing.lineNumber, 'bad indentation: this line is less indented than the document root');
      }
    }

    if (!isObject(value)) {
      this.fail(first.lineNumber, 'the top level of the file must be a mapping of "key: value" pairs');
    }

    return value;
  }

  private fail(lineNumber: number, message: string): never {
    throw new YamlParseError(this.source, lineNumber, message);
  }

  /** Next non-blank, non-comment line without consuming it. */
  private peek(): ContentLine | null {
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]!;
      const indent = countIndent(raw);

      if (raw[indent] === '\t') {
        this.fail(this.index + 1, 'tab character used for indentation; use spaces instead');
      }

      const text = stripComment(raw.slice(indent)).trimEnd();
      if (text === '') {
        this.index += 1;
        continue;
      }

      return { indent, text, lineNumber: this.index + 1 };
    }

    return null;
  }

  /** Parse the node starting at the next content line (mapping, sequence, or scalar). */
  private parseNode(): unknown {
    const line = this.peek();
    if (!line) return null;
    if (line.text.startsWith('? ')) this.fail(line.lineNumber, 'complex mapping keys ("? ") are not supported');
    if (isSequenceItem(line.text)) return this.parseSequence(line.indent);
    if (findKeySeparator(line.text) !== -1) return this.parseMapping(line.indent);

    this.index += 1;
    return this.parseInlineValue(line.text, Math.max(line.indent - 1, 0), line.lineNumber);
  }

  private parseMapping(indent: number): UnknownMap {
    const output: UnknownMap = {};

    while (true) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.text === '---' || line.text === '...') break;

      if (line.indent > indent) {
        this.fail(
          line.lineNumber,
          `bad indentation: expected ${indent} leading space${indent === 1 ? '' : 's'} to continue the mapping, found ${line.indent}. ` +
            'If this line should be part of the previous value, use a block scalar ("key: |") or quote the whole value.',
        );
      }

      if (isSequenceItem(line.text)) {
        this.fail(line.lineNumber, 'unexpected "-" sequence item inside a mapping; nest list items under a "key:" line');
      }

      if (line.text.startsWith('? ')) {
        this.fail(line.lineNumber, 'complex mapping keys ("? ") are not supported');
      }

      const separator = findKeySeparator(line.text);
      if (separator === -1) {
        const colon = line.text.indexOf(':');
        if (colon !== -1) {
          this.fail(line.lineNumber, `expected "key: value" — add a space after the ":" (near "${line.text.slice(0, colon + 2)}")`);
        }
        this.fail(line.lineNumber, `expected "key: value" or "key:", got "${line.text}"`);
      }

      const rawKey = line.text.slice(0, separator).trim();
      if (rawKey === '') this.fail(line.lineNumber, 'empty keys are not supported');
      const key = this.parseKey(rawKey, line.lineNumber);

      if (Object.hasOwn(output, key)) {
        this.fail(line.lineNumber, `duplicate key "${key}" (already defined earlier in the same mapping)`);
      }

      this.index += 1;
      const rest = line.text.slice(separator + 1).trim();
      defineKey(output, key, this.parseValue(rest, indent, line.lineNumber));
    }

    return output;
  }

  private parseKey(rawKey: string, lineNumber: number): string {
    if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
      const quoted = readQuotedString(rawKey, 0);
      if (!quoted || rawKey.slice(quoted.end).trim() !== '') {
        this.fail(lineNumber, `invalid quoted key ${rawKey}`);
      }
      return quoted.value;
    }

    if (rawKey.startsWith('&') || rawKey.startsWith('*') || rawKey.startsWith('!')) {
      this.fail(lineNumber, 'YAML anchors, aliases, and tags (&, *, !) are not supported');
    }

    return rawKey;
  }

  /** Parse the value of `key: <rest>`, which may continue on following lines. */
  private parseValue(rest: string, keyIndent: number, keyLineNumber: number): unknown {
    if (rest === '') {
      const next = this.peek();
      if (next && next.indent > keyIndent) return this.parseNode();
      // Compose-style sequences may sit at the same indent as their key.
      if (next && next.indent === keyIndent && isSequenceItem(next.text)) return this.parseSequence(keyIndent);
      return null;
    }

    return this.parseInlineValue(rest, keyIndent, keyLineNumber);
  }

  /** Parse a value that starts on the current line (after `key:` or `- `). */
  private parseInlineValue(text: string, parentIndent: number, lineNumber: number): unknown {
    const first = text[0]!;

    if (first === '|' || first === '>') return this.parseBlockScalar(text, parentIndent, lineNumber);
    if (first === '[' || first === '{') return this.parseFlowValue(text, lineNumber);
    if (first === '&' || first === '*') this.fail(lineNumber, 'YAML anchors and aliases (& / *) are not supported');
    if (first === '!') this.fail(lineNumber, 'YAML tags (!...) are not supported');

    if (first === '"' || first === "'") {
      const quoted = readQuotedString(text, 0);
      if (!quoted) this.fail(lineNumber, `unterminated ${first === '"' ? 'double' : 'single'}-quoted string`);
      const trailing = text.slice(quoted.end).trim();
      if (trailing !== '') this.fail(lineNumber, `unexpected content after the closing quote: "${trailing}"`);
      return quoted.value;
    }

    return typedScalar(text);
  }

  /** Parse a `|` or `>` block scalar whose header sits on `headerLineNumber`. */
  private parseBlockScalar(header: string, parentIndent: number, headerLineNumber: number): string {
    const style = header[0] as '|' | '>';
    let chomp: 'clip' | 'strip' | 'keep' = 'clip';
    let indentDigit: number | undefined;

    for (const char of header.slice(1)) {
      if (char === '-' && chomp === 'clip') chomp = 'strip';
      else if (char === '+' && chomp === 'clip') chomp = 'keep';
      else if (/[1-9]/.test(char) && indentDigit === undefined) indentDigit = Number(char);
      else this.fail(headerLineNumber, `invalid block scalar header "${header}" (expected e.g. "|", "|-", ">", ">-")`);
    }

    let blockIndent = indentDigit === undefined ? undefined : parentIndent + indentDigit;
    const collected: string[] = [];

    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]!;

      if (raw.trim() === '') {
        collected.push('');
        this.index += 1;
        continue;
      }

      const indent = countIndent(raw);
      if (indent <= parentIndent) break;

      if (blockIndent === undefined) blockIndent = indent;
      if (indent < blockIndent) {
        this.fail(this.index + 1, `block scalar line is less indented than its first line (expected at least ${blockIndent} spaces)`);
      }

      collected.push(raw.slice(blockIndent));
      this.index += 1;
    }

    // Trailing blank lines only matter for the "+" chomping indicator.
    while (collected.length > 0 && collected[collected.length - 1] === '' && chomp !== 'keep') collected.pop();

    const body = style === '|' ? collected.join('\n') : foldLines(collected);

    if (chomp === 'strip') return body.replace(/\n+$/, '');
    if (chomp === 'keep') return body === '' ? '' : `${body}\n`;
    const clipped = body.replace(/\n+$/, '');
    return clipped === '' ? '' : `${clipped}\n`;
  }

  /** Parse a `[...]` / `{...}` flow value, consuming extra lines until brackets balance. */
  private parseFlowValue(text: string, startLineNumber: number): unknown {
    let combined = text;
    let depth = flowDepthDelta(text);
    let singleLine = true;

    while (depth > 0 && this.index < this.lines.length) {
      const raw = this.lines[this.index]!;
      this.index += 1;
      const stripped = stripComment(raw).trim();
      combined += ` ${stripped}`;
      depth += flowDepthDelta(stripped);
      singleLine = false;
    }

    if (depth > 0) {
      const open = text[0]!;
      this.fail(startLineNumber, `unterminated flow collection: missing closing "${open === '[' ? ']' : '}'}"`);
    }

    return new FlowParser(combined, this.source, startLineNumber, singleLine).parse();
  }

  private parseSequence(indent: number): unknown[] {
    const output: unknown[] = [];

    while (true) {
      const line = this.peek();
      if (!line || line.indent !== indent || !isSequenceItem(line.text)) break;

      // A lone "-" takes its value from the following, more-indented lines.
      if (line.text === '-') {
        this.index += 1;
        const next = this.peek();
        output.push(next && next.indent > indent ? this.parseNode() : null);
        continue;
      }

      const body = line.text.slice(1);
      const content = body.trimStart();
      const contentIndent = indent + 1 + (body.length - content.length);

      // "- key: value" and "- - item" start a nested node on the same line.
      // Rewrite the line as if the content began at its own column and
      // re-parse, so continuation lines at that indent join the same node.
      if (isSequenceItem(content) || findKeySeparator(content) !== -1) {
        this.lines[this.index] = ' '.repeat(contentIndent) + content;
        output.push(this.parseNode());
        continue;
      }

      this.index += 1;
      output.push(this.parseInlineValue(content, indent, line.lineNumber));
    }

    return output;
  }
}

export function parseYaml(text: string, sourceName = 'YAML'): UnknownMap {
  return new YamlParser(text, sourceName).parse();
}
