const MAX_INDEXED_TOKENS_PER_PAGE = 8_000;

export function normalizeCatalogSearchValue(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens persisted beside each page let Firestore jump directly to matching
 * pages. The cap stays well below Firestore's 40,000 index-entry limit.
 */
export function buildCatalogSearchTokens(value: string) {
  const tokens = normalizeCatalogSearchValue(value).split(' ').filter(Boolean);
  return Array.from(new Set(tokens)).slice(0, MAX_INDEXED_TOKENS_PER_PAGE);
}
