import type { DocumentDef } from './mockData';
import { isStaticSite } from './runtimeConfig';

const warmedIndexes = new Set<string>();
let viewerRoutePromise: Promise<unknown> | null = null;
let globalPrefetchStarted = false;

export function prefetchViewerRoute() {
  if (!viewerRoutePromise) {
    viewerRoutePromise = import('../pages/ViewerPage').catch((error) => {
      viewerRoutePromise = null;
      throw error;
    });
  }
  return viewerRoutePromise;
}

// The search index is small and independent from the PDF bytes. It is safe to
// warm on server deployments; static/Firebase builds already carry metadata.
function warmSearchIndex(doc: DocumentDef) {
  if (isStaticSite || warmedIndexes.has(doc.id)) return Promise.resolve();
  warmedIndexes.add(doc.id);
  const options: RequestInit & { priority?: 'low' } = { cache: 'force-cache' };
  if ('priority' in Request.prototype) options.priority = 'low';
  return fetch(`/api/documents/${encodeURIComponent(doc.id)}/search-index`, options)
    .then(() => undefined)
    .catch(() => {
      warmedIndexes.delete(doc.id);
    });
}

// User intent loads only the viewer code and a small text index. The PDF itself
// is never downloaded here: the active viewer exclusively owns PDF traffic.
export function prefetchPdfDocument(doc: DocumentDef) {
  void prefetchViewerRoute().catch(() => undefined);
  void warmSearchIndex(doc);
}

// Global preparation deliberately avoids all catalog files. This prevents the
// library page from competing with the one PDF the user actually opens.
export function startGlobalPdfPrefetch(docs: DocumentDef[]) {
  if (globalPrefetchStarted || !Array.isArray(docs) || docs.length === 0) return;
  globalPrefetchStarted = true;

  const run = () => {
    void prefetchViewerRoute().catch(() => undefined);
  };

  const requestIdle = (window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (requestIdle) {
    requestIdle(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 1200);
  }
}
