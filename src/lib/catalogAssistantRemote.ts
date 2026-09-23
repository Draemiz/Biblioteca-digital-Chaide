import type { CatalogAssistantSource } from './catalogAssistant';

type RemoteCitation = {
  catalogId: string;
  pageNumber: number;
  indexVersion: string;
};

type RemoteAssistantResponse = {
  answer?: unknown;
  citations?: unknown;
};

export type GroundedRemoteAnswer = {
  text: string;
  sources: CatalogAssistantSource[];
};

const configuredEndpoint = String(import.meta.env.VITE_CATALOG_ASSISTANT_API_URL || '').trim();
const responseCache = new Map<string, GroundedRemoteAnswer>();
let remoteBackoffUntil = 0;

function sourceKey(source: Pick<CatalogAssistantSource, 'catalogId' | 'pageNumber' | 'indexVersion'>) {
  return `${source.catalogId}:${source.indexVersion}:${source.pageNumber}`;
}

function responseCacheKey(question: string, sources: CatalogAssistantSource[]) {
  const normalizedQuestion = question
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalizedQuestion}|${sources.map(sourceKey).sort().join('|')}`;
}

function cacheResponse(key: string, answer: GroundedRemoteAnswer) {
  responseCache.set(key, answer);
  if (responseCache.size > 40) {
    const oldest = responseCache.keys().next().value;
    if (typeof oldest === 'string') responseCache.delete(oldest);
  }
}

function isRemoteCitation(value: unknown): value is RemoteCitation {
  if (!value || typeof value !== 'object') return false;
  const citation = value as Partial<RemoteCitation>;
  return typeof citation.catalogId === 'string' &&
    citation.catalogId.length > 0 &&
    typeof citation.indexVersion === 'string' &&
    citation.indexVersion.length > 0 &&
    Number.isInteger(citation.pageNumber) &&
    Number(citation.pageNumber) > 0;
}

/**
 * The model is an optional writing layer. The browser accepts its answer only
 * when every cited catalogue/page was part of the locally retrieved evidence.
 */
export async function requestGroundedCatalogAnswer(
  question: string,
  retrievedSources: CatalogAssistantSource[],
): Promise<GroundedRemoteAnswer | null> {
  if (!configuredEndpoint || retrievedSources.length === 0) return null;
  const cacheKey = responseCacheKey(question, retrievedSources);
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;
  if (Date.now() < remoteBackoffUntil) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(configuredEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.slice(0, 600),
        sources: retrievedSources.slice(0, 6).map((source) => ({
          catalogId: source.catalogId,
          indexVersion: source.indexVersion,
          title: source.title.slice(0, 180),
          pageNumber: source.pageNumber,
          text: source.snippet.slice(0, 1_200),
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) remoteBackoffUntil = Date.now() + 65_000;
      if (response.status === 503) remoteBackoffUntil = Date.now() + 5 * 60_000;
      return null;
    }

    const payload = await response.json() as RemoteAssistantResponse;
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    const citations = Array.isArray(payload.citations)
      ? payload.citations.filter(isRemoteCitation)
      : [];
    if (!answer || answer.length > 2_500 || citations.length === 0) return null;

    const allowedSources = new Map(retrievedSources.map((source) => [sourceKey(source), source]));
    const citedSources: CatalogAssistantSource[] = [];
    const seen = new Set<string>();
    for (const citation of citations) {
      const key = sourceKey(citation);
      const source = allowedSources.get(key);
      if (!source || seen.has(key)) continue;
      seen.add(key);
      citedSources.push(source);
    }

    // Reject the complete generated answer if the model invents or omits its
    // evidence. The deterministic search answer remains available as fallback.
    if (citedSources.length !== citations.length || citedSources.length === 0) return null;
    const groundedAnswer = { text: answer, sources: citedSources };
    remoteBackoffUntil = 0;
    cacheResponse(cacheKey, groundedAnswer);
    return groundedAnswer;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
