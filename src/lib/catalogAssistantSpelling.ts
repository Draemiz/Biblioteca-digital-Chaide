export type CatalogSpellingCorrection = {
  from: string;
  to: string;
};

export type CatalogQueryResolution = {
  tokens: string[];
  corrections: CatalogSpellingCorrection[];
};

export type CatalogVocabulary = Map<string, number>;

function normalizeWord(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Builds a compact vocabulary without sending catalogue text to another service. */
export function buildCatalogVocabulary(
  entries: Iterable<{ text: string; weight: number }>,
): CatalogVocabulary {
  const vocabulary: CatalogVocabulary = new Map();
  for (const entry of entries) {
    const words = String(entry.text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
    const uniqueWords = new Set(words);
    for (const word of uniqueWords) {
      if (word.length < 3 || word.length > 32 || /^\d+$/.test(word)) continue;
      vocabulary.set(word, (vocabulary.get(word) || 0) + Math.max(1, entry.weight));
    }
  }
  return vocabulary;
}

/** Optimal-string-alignment distance; adjacent letter swaps count as one typo. */
export function catalogTypoDistance(leftValue: string, rightValue: string) {
  const left = normalizeWord(leftValue);
  const right = normalizeWord(rightValue);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const matrix = Array.from(
    { length: left.length + 1 },
    () => new Array<number>(right.length + 1).fill(0),
  );
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitution,
      );
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

type Candidate = { word: string; distance: number; weight: number };

function typoLimit(length: number) {
  if (length <= 5) return 1;
  if (length <= 12) return 2;
  return 3;
}

function bestCandidate(token: string, vocabulary: CatalogVocabulary): Candidate | null {
  const limit = typoLimit(token.length);
  const candidates: Candidate[] = [];
  for (const [word, weight] of vocabulary) {
    if (Math.abs(word.length - token.length) > limit) continue;
    const distance = catalogTypoDistance(token, word);
    if (distance > limit) continue;
    const similarity = 1 - distance / Math.max(token.length, word.length);
    if (similarity < 0.72) continue;
    candidates.push({ word, distance, weight });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.weight - a.weight || a.word.localeCompare(b.word));
  const best = candidates[0];
  if (!best) return null;

  if (best.distance >= 2 && best.weight < 4) return null;
  if (token[0] !== best.word[0] && (best.distance !== 1 || best.weight < 8)) return null;

  const runnerUp = candidates[1];
  if (
    runnerUp &&
    runnerUp.distance === best.distance &&
    runnerUp.weight >= best.weight * 0.6
  ) return null;
  return best;
}

export function resolveCatalogQueryTokens(
  rawTokens: string[],
  vocabulary: CatalogVocabulary,
  ignoredTerms: ReadonlySet<string> = new Set(),
): CatalogQueryResolution {
  const tokens: string[] = [];
  const corrections: CatalogSpellingCorrection[] = [];
  const ignoredVocabulary: CatalogVocabulary = new Map(
    Array.from(ignoredTerms, (word) => [word, 100]),
  );

  for (const rawToken of rawTokens) {
    const token = normalizeWord(rawToken);
    if (!token || ignoredTerms.has(token)) continue;
    if (vocabulary.has(token) || token.length < 4) {
      tokens.push(token);
      continue;
    }

    const ignoredMatch = bestCandidate(token, ignoredVocabulary);
    if (ignoredMatch?.distance === 1) continue;

    const candidate = bestCandidate(token, vocabulary);
    if (!candidate || candidate.word === token) {
      tokens.push(token);
      continue;
    }
    tokens.push(candidate.word);
    corrections.push({ from: token, to: candidate.word });
  }

  return {
    tokens: Array.from(new Set(tokens)),
    corrections: corrections.filter(
      (correction, index, values) => values.findIndex(
        (item) => item.from === correction.from && item.to === correction.to,
      ) === index,
    ),
  };
}

export function applyCatalogSpellingCorrections(
  question: string,
  corrections: CatalogSpellingCorrection[],
) {
  if (corrections.length === 0) return question;
  const replacements = new Map(corrections.map((correction) => [correction.from, correction.to]));
  return question.replace(/[\p{L}\p{N}]+/gu, (word) => replacements.get(normalizeWord(word)) || word);
}

const CONTEXT_GENERIC_TERMS = new Set([
  'ademas', 'alto', 'altura', 'ancho', 'caracteristica', 'caracteristicas', 'color', 'colores',
  'como', 'con', 'cual', 'cuales', 'cuanto', 'cuantos', 'dime', 'donde', 'informacion', 'largo',
  'del', 'mas', 'material', 'materiales', 'medida', 'medidas', 'modelo', 'otro', 'otros',
  'pagina', 'paginas', 'producto',
  'productos', 'que', 'quien', 'tambien', 'tiene', 'tienen', 'para', 'por', 'sobre',
  'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'mismo', 'misma',
]);

function catalogSubjectTokens(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length >= 3 && !CONTEXT_GENERIC_TERMS.has(word)) || [];
}

/** Adds only the previous product subject to short conversational follow-ups. */
export function contextualizeCatalogQuestion(question: string, previousQuestion?: string) {
  const cleanQuestion = String(question || '').trim();
  const previousSubjects = catalogSubjectTokens(previousQuestion || '');
  if (!cleanQuestion || previousSubjects.length === 0) {
    return { question: cleanQuestion, usedContext: false };
  }
  const normalized = cleanQuestion
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const currentSubjects = catalogSubjectTokens(cleanQuestion);
  const explicitlyContinues = /^(y\b|tambien\b|ademas\b|sobre eso\b|del mismo\b)/.test(normalized);
  const genericFollowUp = currentSubjects.length === 0 && normalized.split(/\s+/).length <= 7;
  if (!explicitlyContinues && !genericFollowUp) {
    return { question: cleanQuestion, usedContext: false };
  }
  const uniqueSubjects = Array.from(new Set(previousSubjects)).slice(0, 4);
  return {
    question: `${cleanQuestion} ${uniqueSubjects.join(' ')}`,
    usedContext: true,
  };
}
