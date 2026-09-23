import type { DocumentDef } from './mockData';
import {
  loadPersistedCatalogSearchIndex,
  normalizeCatalogSearchText,
  type CatalogSearchPageData,
} from './catalogSearchIndex';
import {
  assistantDocumentVersion,
  isAssistantDocumentEligible,
} from './catalogAssistantFreshness';
import {
  applyCatalogSpellingCorrections,
  buildCatalogVocabulary,
  resolveCatalogQueryTokens,
  type CatalogSpellingCorrection,
  type CatalogVocabulary,
} from './catalogAssistantSpelling';

export type CatalogAssistantSource = {
  catalogId: string;
  title: string;
  pageNumber: number;
  snippet: string;
  score: number;
  searchTerm: string;
  indexVersion: string;
};

export type CatalogAssistantAnswer = {
  text: string;
  sources: CatalogAssistantSource[];
  searchedCatalogs: number;
  searchedPages: number;
  corrections: CatalogSpellingCorrection[];
  interpretedQuestion: string;
};

const STOP_WORDS = new Set([
  'a', 'al', 'algo', 'como', 'con', 'cual', 'cuales', 'cuando', 'de', 'del',
  'datos', 'dime', 'donde', 'el', 'en', 'es', 'esa', 'ese', 'esta', 'este', 'hay',
  'informacion', 'la', 'las', 'lo', 'los', 'mas', 'me', 'otro', 'otros', 'para', 'pero', 'por', 'puede',
  'que', 'saber', 'se', 'si', 'son', 'su', 'sus', 'tiene', 'un', 'una', 'y', 'yo',
]);

const SYNONYMS: Record<string, string[]> = {
  alto: ['altura'],
  ancho: ['anchura'],
  caracteristicas: ['especificaciones', 'beneficios', 'propiedades'],
  colores: ['color', 'tonos'],
  dimensiones: ['medidas', 'tamano', 'altura', 'ancho', 'largo'],
  firmeza: ['firme', 'confort'],
  material: ['materiales', 'composicion', 'tela'],
  medidas: ['dimensiones', 'tamano', 'altura', 'ancho', 'largo'],
  modelo: ['producto', 'linea'],
  tamano: ['medidas', 'dimensiones'],
};

type CachedIndex = {
  key: string;
  pages: CatalogSearchPageData[];
};

const indexCache = new Map<string, Promise<CachedIndex>>();
let vocabularyCache: { key: string; vocabulary: CatalogVocabulary } | null = null;

function documentIndexKey(document: DocumentDef) {
  return `${document.id}:${assistantDocumentVersion(document)}`;
}

export function pruneCatalogAssistantCache(documents: DocumentDef[]) {
  const currentKeys = new Set(documents.filter(isAssistantDocumentEligible).map(documentIndexKey));
  for (const key of indexCache.keys()) {
    if (!currentKeys.has(key)) indexCache.delete(key);
  }
  if (vocabularyCache && vocabularyCache.key !== Array.from(currentKeys).sort().join('|')) {
    vocabularyCache = null;
  }
}

function queryTokens(value: string) {
  return Array.from(new Set(
    normalizeCatalogSearchText(value)
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length >= 2),
  ));
}

function vocabularyForIndexes(
  indexes: Array<{ document: DocumentDef; pages: CatalogSearchPageData[] }>,
) {
  const key = indexes.map(({ document }) => documentIndexKey(document)).sort().join('|');
  if (vocabularyCache?.key === key) return vocabularyCache.vocabulary;
  function* entries() {
    for (const { document, pages } of indexes) {
      yield { text: document.title, weight: 30 };
      yield { text: document.category || '', weight: 16 };
      yield { text: document.description || '', weight: 8 };
      yield { text: (document.tags || []).join(' '), weight: 20 };
      for (const page of pages) yield { text: page.text, weight: 2 };
    }
  }
  const vocabulary = buildCatalogVocabulary(entries());
  vocabularyCache = { key, vocabulary };
  return vocabulary;
}

function expandedTokens(tokens: string[]) {
  return Array.from(new Set(tokens.flatMap((token) => [token, ...(SYNONYMS[token] || [])])));
}

function countOccurrences(text: string, term: string) {
  let count = 0;
  let cursor = 0;
  while (count < 5) {
    const next = text.indexOf(term, cursor);
    if (next < 0) break;
    count += 1;
    cursor = next + term.length;
  }
  return count;
}

function scorePage(
  pageText: string,
  normalizedQuestion: string,
  tokens: string[],
  expanded: string[],
) {
  const normalized = normalizeCatalogSearchText(pageText);
  if (!normalized) return 0;

  let score = 0;
  if (normalizedQuestion.length >= 4 && normalized.includes(normalizedQuestion)) score += 32;
  let matchedCore = 0;
  for (const token of tokens) {
    const occurrences = countOccurrences(normalized, token);
    if (occurrences > 0) {
      matchedCore += 1;
      score += 7 + Math.min(occurrences, 3) * 2;
    }
  }
  for (const token of expanded) {
    if (!tokens.includes(token) && normalized.includes(token)) score += 3;
  }
  if (tokens.length > 1 && matchedCore < Math.min(2, tokens.length)) return 0;
  if (matchedCore === tokens.length && tokens.length > 1) score += 18;
  score += Math.round((matchedCore / Math.max(tokens.length, 1)) * 10);
  return score;
}

function makeSnippet(text: string, tokens: string[]) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const normalized = normalizeCatalogSearchText(cleaned);
  const positions = tokens
    .map((token) => normalized.indexOf(token))
    .filter((position) => position >= 0);
  const match = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, match - 105);
  const end = Math.min(cleaned.length, match + 235);
  let snippet = cleaned.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < cleaned.length) snippet = `${snippet}…`;
  return snippet;
}

async function loadIndex(document: DocumentDef) {
  const key = documentIndexKey(document);
  const existing = indexCache.get(key);
  if (existing) return existing;
  const request = loadPersistedCatalogSearchIndex(document)
    .then((pages) => ({ key, pages }))
    .catch(() => ({ key, pages: [] }));
  indexCache.set(key, request);
  return request;
}

export async function answerCatalogQuestion(
  question: string,
  documents: DocumentDef[],
  currentCatalogId?: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<CatalogAssistantAnswer> {
  const rawTokens = queryTokens(question);
  if (rawTokens.length === 0) {
    return {
      text: 'Escribe el producto, medida, material o característica que deseas consultar.',
      sources: [],
      searchedCatalogs: 0,
      searchedPages: 0,
      corrections: [],
      interpretedQuestion: question,
    };
  }

  pruneCatalogAssistantCache(documents);
  const eligible = documents.filter(isAssistantDocumentEligible);
  const indexes: Array<{ document: DocumentDef; pages: CatalogSearchPageData[] }> = [];
  let nextDocument = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (nextDocument < eligible.length) {
      const document = eligible[nextDocument++];
      const index = await loadIndex(document);
      indexes.push({ document, pages: index.pages });
      completed += 1;
      onProgress?.(completed, eligible.length);
    }
  });
  await Promise.all(workers);

  const resolution = resolveCatalogQueryTokens(rawTokens, vocabularyForIndexes(indexes), STOP_WORDS);
  const tokens = resolution.tokens;
  const normalizedQuestion = tokens.join(' ');
  const interpretedQuestion = applyCatalogSpellingCorrections(question, resolution.corrections);
  if (tokens.length === 0) {
    return {
      text: 'Escribe el nombre de un producto, una medida, un material o una característica.',
      sources: [],
      searchedCatalogs: eligible.length,
      searchedPages: indexes.reduce((total, item) => total + item.pages.length, 0),
      corrections: resolution.corrections,
      interpretedQuestion,
    };
  }
  const expanded = expandedTokens(tokens);
  const matches: CatalogAssistantSource[] = [];
  let searchedPages = 0;
  for (const { document, pages } of indexes) {
    searchedPages += pages.length;
    const normalizedTitle = normalizeCatalogSearchText(document.title);
    const titleMatches = tokens.filter((token) => normalizedTitle.includes(token)).length;
    const titleRelevance = titleMatches * 12 + (titleMatches >= 2 ? 20 : 0);
    for (const page of pages) {
      let score = scorePage(page.text, normalizedQuestion, tokens, expanded);
      // Product names frequently appear in both the question and catalogue
      // title, while generic words such as "colores" may occur in unrelated
      // catalogues. Title agreement keeps Edredón Zafiro ahead of Sábanas
      // Zafiro without excluding useful cross-catalogue evidence.
      if (score > 0) score += titleRelevance;
      if (document.id === currentCatalogId) score += 3;
      if (score < 10) continue;
      matches.push({
        catalogId: document.id,
        title: document.title,
        pageNumber: page.pageNumber,
        snippet: makeSnippet(page.text, expanded),
        score,
        searchTerm: [...tokens]
          .filter((token) => normalizeCatalogSearchText(page.text).includes(token))
          .sort((a, b) => b.length - a.length)[0] || tokens[0],
        indexVersion: assistantDocumentVersion(document),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
  const sources: CatalogAssistantSource[] = [];
  const perCatalog = new Map<string, number>();
  for (const match of matches) {
    if ((perCatalog.get(match.catalogId) || 0) >= 2) continue;
    sources.push(match);
    perCatalog.set(match.catalogId, (perCatalog.get(match.catalogId) || 0) + 1);
    if (sources.length === 4) break;
  }

  if (sources.length === 0) {
    return {
      text: 'No encontré esa información en el texto de los catálogos publicados. Intenta con el nombre exacto del producto, una medida, un material o un color. No usaré información externa para inventar una respuesta.',
      sources: [],
      searchedCatalogs: eligible.length,
      searchedPages,
      corrections: resolution.corrections,
      interpretedQuestion,
    };
  }

  const primary = sources[0];
  return {
    text: `La información más relacionada aparece en “${primary.title}”, página ${primary.pageNumber}: ${primary.snippet}`,
    sources,
    searchedCatalogs: eligible.length,
    searchedPages,
    corrections: resolution.corrections,
    interpretedQuestion,
  };
}
