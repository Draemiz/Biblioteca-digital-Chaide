import assert from 'node:assert/strict';
import worker from '../workers/catalog-assistant/src/index';
import { filterCurrentAssistantSources } from '../src/lib/catalogAssistantFreshness';
import {
  applyCatalogSpellingCorrections,
  buildCatalogVocabulary,
  catalogTypoDistance,
  contextualizeCatalogQuestion,
  resolveCatalogQueryTokens,
} from '../src/lib/catalogAssistantSpelling';
import { rankCatalogSearchResults } from '../src/lib/catalogSearchResults';
import { createCatalogViewerHref } from '../src/lib/catalogViewerLink';

const origin = 'https://biblioteca-catalogos-chaide.web.app';
const source = {
  catalogId: 'catalogo-edredones',
  indexVersion: 'version-zafiro-2026',
  title: 'Catálogo de edredones',
  pageNumber: 8,
  text: 'EDREDÓN ZÁFIRO LLANO. Colores disponibles: plomo, habano y celeste.',
};

function request(body: unknown, requestOrigin = origin) {
  return new Request('https://assistant.example.test/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': requestOrigin,
    },
    body: JSON.stringify(body),
  });
}

const validEnv = {
  AI: {
    async run() {
      return {
        response: JSON.stringify({
          answer: 'El edredón Zafiro está disponible en plomo, habano y celeste.',
          citations: [{
            catalogId: source.catalogId,
            indexVersion: source.indexVersion,
            pageNumber: source.pageNumber,
          }],
          insufficientEvidence: false,
        }),
      };
    },
  },
};

const validResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}), validEnv);
assert.equal(validResponse.status, 200);
assert.deepEqual((await validResponse.json() as { citations: unknown }).citations, [
  { catalogId: source.catalogId, indexVersion: source.indexVersion, pageNumber: source.pageNumber },
]);

const inventedCitationResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}), {
  AI: {
    async run() {
      return {
        response: JSON.stringify({
          answer: 'Respuesta inventada.',
          citations: [{ catalogId: 'catalogo-inventado', indexVersion: 'inventada', pageNumber: 99 }],
        }),
      };
    },
  },
});
assert.equal(inventedCitationResponse.status, 502);

const staleVersionResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}), {
  AI: {
    async run() {
      return {
        response: JSON.stringify({
          answer: 'El edredón Zafiro está disponible en plomo.',
          citations: [{
            catalogId: source.catalogId,
            indexVersion: 'version-anterior',
            pageNumber: source.pageNumber,
          }],
        }),
      };
    },
  },
});
assert.equal(staleVersionResponse.status, 502);

const inventedNumberResponse = await worker.fetch(request({
  question: '¿Cuánto mide el edredón Zafiro?',
  sources: [source],
}), {
  AI: {
    async run() {
      return {
        response: JSON.stringify({
          answer: 'El edredón Zafiro mide 99 centímetros.',
          citations: [{
            catalogId: source.catalogId,
            indexVersion: source.indexVersion,
            pageNumber: source.pageNumber,
          }],
        }),
      };
    },
  },
});
assert.equal(inventedNumberResponse.status, 502);

const invalidOriginResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}, 'https://sitio-no-autorizado.example'), validEnv);
assert.equal(invalidOriginResponse.status, 403);

const rateLimitedResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}), {
  ...validEnv,
  RATE_LIMITER: {
    async limit() {
      return { success: false };
    },
  },
});
assert.equal(rateLimitedResponse.status, 429);

const unavailableAiResponse = await worker.fetch(request({
  question: '¿Qué colores tiene el edredón Zafiro?',
  sources: [source],
}), {
  AI: {
    async run() {
      throw new Error('Cuota gratuita agotada');
    },
  },
});
assert.equal(unavailableAiResponse.status, 503);

const indexedDocument = {
  id: source.catalogId,
  title: source.title,
  description: 'Catálogo vigente para probar el asistente.',
  category: 'Dormitorio',
  pageCount: 9,
  coverUrl: '',
  fileUrl: 'firestore://catalogo-edredones/version-zafiro-2026',
  tags: ['edredón'],
  status: 'ready' as const,
  isActive: true,
  visibility: 'public' as const,
  searchIndexStatus: 'ready' as const,
  searchIndexVersion: source.indexVersion,
};

const indexedSource = {
  catalogId: source.catalogId,
  indexVersion: source.indexVersion,
  title: source.title,
  pageNumber: source.pageNumber,
  snippet: source.text,
  score: 100,
  searchTerm: 'zafiro',
};

assert.deepEqual(filterCurrentAssistantSources([indexedSource], [indexedDocument]), [indexedSource]);
assert.deepEqual(filterCurrentAssistantSources([
  { ...indexedSource, indexVersion: 'version-anterior' },
], [indexedDocument]), []);
assert.deepEqual(filterCurrentAssistantSources([indexedSource], []), []);
assert.deepEqual(filterCurrentAssistantSources([indexedSource], [
  { ...indexedDocument, visibility: 'private' as const },
]), []);
assert.deepEqual(filterCurrentAssistantSources([indexedSource], [
  { ...indexedDocument, status: 'processing' as const },
]), []);
assert.deepEqual(filterCurrentAssistantSources([
  { ...indexedSource, pageNumber: indexedDocument.pageCount + 1 },
], [indexedDocument]), []);

const spellingVocabulary = buildCatalogVocabulary([
  { text: 'CATÁLOGO EDREDONES ZAFIRO', weight: 30 },
  { text: 'Almohada ortopédica y producto matrimonial', weight: 20 },
  { text: 'EDREDÓN ZÁFIRO LLANO PLOMO HABANO CELESTE', weight: 8 },
]);
assert.equal(catalogTypoDistance('prodcuto', 'producto'), 1);
assert.deepEqual(
  resolveCatalogQueryTokens(['edrdon', 'safiro'], spellingVocabulary).corrections,
  [
    { from: 'edrdon', to: 'edredon' },
    { from: 'safiro', to: 'zafiro' },
  ],
);
assert.deepEqual(
  resolveCatalogQueryTokens(['almhoada', 'ortopdica'], spellingVocabulary).tokens,
  ['almohada', 'ortopedica'],
);
assert.deepEqual(
  resolveCatalogQueryTokens(['televisor'], spellingVocabulary),
  { tokens: ['televisor'], corrections: [] },
);
assert.deepEqual(
  resolveCatalogQueryTokens(['tinen', 'zafiro'], spellingVocabulary, new Set(['tiene', 'tienen'])).tokens,
  ['zafiro'],
);
assert.equal(
  applyCatalogSpellingCorrections('¿Qué colres tiene el edrdon safiro?', [
    { from: 'colres', to: 'colores' },
    { from: 'edrdon', to: 'edredon' },
    { from: 'safiro', to: 'zafiro' },
  ]),
  '¿Qué colores tiene el edredon zafiro?',
);

assert.deepEqual(
  contextualizeCatalogQuestion(
    '¿Y qué medidas tiene?',
    '¿Qué colores tiene el edredón Zafiro?',
  ),
  { question: '¿Y qué medidas tiene? edredon zafiro', usedContext: true },
);
assert.deepEqual(
  contextualizeCatalogQuestion(
    '¿Qué colores tiene el colchón Continental?',
    '¿Qué colores tiene el edredón Zafiro?',
  ),
  { question: '¿Qué colores tiene el colchón Continental?', usedContext: false },
);

const rankedResults = rankCatalogSearchResults([
  { catalogId: 'zafiro', pageNumber: 1, source: 'catalog-title' as const, label: 'Título' },
  { catalogId: 'zafiro', pageNumber: 8, source: 'pdf-content' as const, label: 'Página 8' },
  { catalogId: 'zafiro', pageNumber: 9, source: 'pdf-content' as const, label: 'Página 9' },
  { catalogId: 'otro', pageNumber: 1, source: 'catalog-description' as const, label: 'Otro' },
]);
assert.deepEqual(rankedResults.map((result) => result.label), ['Página 8', 'Página 9', 'Otro']);
assert.equal(
  createCatalogViewerHref({ catalogId: 'catálogo/zafiro', pageNumber: 8, search: 'edredón zafiro' }),
  '/viewer/cat%C3%A1logo%2Fzafiro?page=8&search=edred%C3%B3n+zafiro',
);

console.log('Catalog assistant verification passed: grounded citations, typo recovery, current-version filtering and fallback contracts are valid.');
