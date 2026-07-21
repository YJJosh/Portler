/**
 * Shared quote-aware scanning for the YAML-subset and dotenv parsers, so the
 * escaping rules (backslash escapes inside double quotes, none inside single
 * quotes) live in one place.
 */

/**
 * Characters after which a quote is understood to START a quoted span. A quote
 * anywhere else is a literal character in a bare scalar — without this rule the
 * apostrophe in `msg: it's fine # note` would open a span that never closes,
 * hiding the trailing comment and swallowing the rest of the line.
 */
const QUOTE_OPENER_PREDECESSORS = /[\s:=,[{(-]/;

function opensQuotedSpan(input: string, index: number): boolean {
  if (index === 0) return true;
  return QUOTE_OPENER_PREDECESSORS.test(input[index - 1]!);
}

/**
 * Return the index of the first character outside any quoted span for which
 * `predicate` returns true, or -1. The predicate is never consulted for
 * characters inside quotes or for the quote characters themselves.
 */
export function findUnquoted(input: string, predicate: (char: string, index: number) => boolean): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }

      if (char === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }

    if ((char === '"' || char === "'") && opensQuotedSpan(input, index)) {
      quote = char;
      continue;
    }

    if (predicate(char, index)) return index;
  }

  return -1;
}

/** Strip an unquoted trailing `# comment` (only when the `#` starts the line or follows whitespace) and trim the end. */
export function stripComment(input: string): string {
  const index = findUnquoted(input, (char, at) => char === '#' && (at === 0 || /\s/.test(input[at - 1] ?? '')));
  return (index === -1 ? input : input.slice(0, index)).trimEnd();
}

/** Unquote a `"..."` value, tolerating invalid escapes by falling back to a plain slice. */
export function unquoteDoubleQuoted(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}
