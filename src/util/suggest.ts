/** Small edit-distance helpers used to add "did you mean ...?" hints to errors. */

/** Case-sensitive Levenshtein edit distance. */
export function editDistance(left: string, right: string): number {
  const columns = right.length + 1;
  let previous = Array.from({ length: columns }, (_unused, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = [row];
    for (let column = 1; column < columns; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
    }
    previous = current;
  }

  return previous[columns - 1]!;
}

/**
 * The candidate closest to `input` (case-insensitive), or undefined when even
 * the best candidate is too far away to be a plausible typo.
 */
export function closestMatch(input: string, candidates: Iterable<string>): string | undefined {
  const target = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(target, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const threshold = target.length <= 3 ? 1 : target.length <= 8 ? 2 : 3;
  return bestDistance <= threshold ? best : undefined;
}

/** ` (did you mean "x"?)` when a close match exists, empty string otherwise. */
export function didYouMean(input: string, candidates: Iterable<string>): string {
  const match = closestMatch(input, candidates);
  return match === undefined || match === input ? '' : ` (did you mean "${match}"?)`;
}
