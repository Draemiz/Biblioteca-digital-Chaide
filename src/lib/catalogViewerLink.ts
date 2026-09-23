export function createCatalogViewerHref({
  catalogId,
  pageNumber,
  search,
}: {
  catalogId: string;
  pageNumber?: number | null;
  search?: string;
}) {
  const safePage = Number.isFinite(Number(pageNumber))
    ? Math.max(1, Math.trunc(Number(pageNumber)))
    : 1;
  const params = new URLSearchParams({ page: String(safePage) });
  const cleanSearch = String(search || '').trim();
  if (cleanSearch) params.set('search', cleanSearch.slice(0, 180));
  return `/viewer/${encodeURIComponent(catalogId)}?${params.toString()}`;
}
