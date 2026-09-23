export function normalizeSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

function editDistance(left: string, right: string) {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost,
      );

      // Treat two adjacent swapped letters as one typing error.
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }

  return matrix[left.length][right.length];
}

function tokenMatches(queryToken: string, candidateToken: string) {
  if (candidateToken.includes(queryToken)) return true;
  if (queryToken.length <= 2) return false;

  const tolerance = queryToken.length >= 8 ? 2 : 1;
  if (Math.abs(queryToken.length - candidateToken.length) > tolerance) return false;
  return editDistance(queryToken, candidateToken) <= tolerance;
}

/**
 * Accent-insensitive, token-based matching with a small typo tolerance.
 * Every word typed by the user must match at least one word in the fields.
 */
export function fuzzyTextMatch(query: string, ...fields: Array<string | null | undefined>) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const normalizedCandidate = normalizeSearchText(fields.filter(Boolean).join(' '));
  if (!normalizedCandidate) return false;
  if (normalizedCandidate.includes(normalizedQuery)) return true;

  const candidateTokens = normalizedCandidate.split(/\s+/).filter(Boolean);
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((queryToken) => candidateTokens.some((candidateToken) => tokenMatches(queryToken, candidateToken)));
}
