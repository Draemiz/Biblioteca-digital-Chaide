export type RankedCatalogSearchResult = {
  catalogId: string;
  pageNumber: number | null;
  source: 'pdf-content' | 'catalog-title' | 'catalog-description';
};

/** Keeps the exact PDF pages ahead of catalogue-level metadata matches. */
export function rankCatalogSearchResults<T extends RankedCatalogSearchResult>(results: T[]) {
  const catalogsWithPageEvidence = new Set(
    results.filter((result) => result.source === 'pdf-content').map((result) => result.catalogId),
  );
  const bestByDestination = new Map<string, T>();
  for (const result of results) {
    if (result.source !== 'pdf-content' && catalogsWithPageEvidence.has(result.catalogId)) continue;
    const page = Math.max(1, Number(result.pageNumber || 1));
    const key = `${result.catalogId}:${page}`;
    const existing = bestByDestination.get(key);
    if (!existing || (existing.source !== 'pdf-content' && result.source === 'pdf-content')) {
      bestByDestination.set(key, result);
    }
  }
  return Array.from(bestByDestination.values()).sort((left, right) => {
    if (left.source === 'pdf-content' && right.source !== 'pdf-content') return -1;
    if (left.source !== 'pdf-content' && right.source === 'pdf-content') return 1;
    const byCatalog = left.catalogId.localeCompare(right.catalogId);
    return byCatalog || Number(left.pageNumber || 1) - Number(right.pageNumber || 1);
  });
}
