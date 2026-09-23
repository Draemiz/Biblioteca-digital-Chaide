import * as pdfjsLib from 'pdfjs-dist';

// Configure the worker once (idempotent — shared module instance).
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

/**
 * Process-wide cache of parsed PDF documents AND rendered page bitmaps, keyed by
 * URL. It keeps only the current and most recently used catalog so reopening
 * either one is quick without allowing old documents to consume memory.
 *
 * Memory is intentionally favoured for speed; an LRU cap keeps it bounded.
 */

const MAX_DOCS = 2;
// Keep a small hot set. Large, image-heavy catalogues can otherwise retain
// hundreds of MB in GPU-backed ImageBitmaps and Chrome may silently blank a
// canvas when it runs out of graphics memory.
const MAX_BITMAPS_PER_DOC = 6;

type DocEntry = {
  url: string;
  promise: Promise<pdfjsLib.PDFDocumentProxy>;
  proxy?: pdfjsLib.PDFDocumentProxy;
  lastUsed: number;
};

const documents = new Map<string, DocEntry>();
const bitmaps = new Map<string, Map<number, { bitmap: ImageBitmap; w: number; h: number }>>();

type ProgressFn = (p: { loaded: number; total: number }) => void;

function buildTask(url: string) {
  const useNativeImageDecoder = new URL(url, window.location.origin)
    .searchParams.get('fastImageDecoder') === '1';
  return pdfjsLib.getDocument({
    url,
    // Keep the HTTP stream enabled. Some large catalogues contain many
    // cross-reference sections; requesting those in tiny isolated ranges makes
    // pdf.js remain at 0 pages for too long. The document bytes stream once,
    // while page parsing and canvas rendering remain strictly windowed around
    // the page selected by the reader.
    disableAutoFetch: false,
    disableStream: false,
    rangeChunkSize: 1048576,
    // Explicitly downsample oversized image layers inside the worker before
    // they reach the main-thread canvas. Layer-heavy catalogues (notably the
    // Zafiro PDF) otherwise decode several 20-80 MB masks at full resolution
    // even though the visible page needs only a fraction of those pixels.
    canvasMaxAreaInBytes: 12 * 1024 * 1024,
    // Chromium disables ImageDecoder by default in pdf.js because arbitrary
    // PDFs may contain problematic colour profiles. Enable it only for our
    // flattened, standard-RGB web derivative, where native JPEG decoding cuts
    // the first paint substantially without changing other catalogues.
    ...(useNativeImageDecoder ? { isImageDecoderSupported: true } : {}),
    cMapUrl: `${window.location.origin}${import.meta.env.BASE_URL}cmaps/`,
    cMapPacked: true,
  });
}

function evict() {
  if (documents.size <= MAX_DOCS) return;
  const sorted = [...documents.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  while (documents.size > MAX_DOCS && sorted.length) {
    const victim = sorted.shift();
    if (!victim) break;
    documents.delete(victim.url);
    // Release rendered bitmaps for the evicted doc.
    const m = bitmaps.get(victim.url);
    if (m) {
      m.forEach((v) => { try { v.bitmap.close?.(); } catch { /* noop */ } });
      bitmaps.delete(victim.url);
    }
    victim.promise.then((p) => { try { p.destroy(); } catch { /* noop */ } }).catch(() => undefined);
  }
}

/** Return the already-parsed document if cached (no work), else null. */
export function getCachedDocument(url: string): pdfjsLib.PDFDocumentProxy | null {
  const e = documents.get(url);
  if (e?.proxy) {
    e.lastUsed = Date.now();
    return e.proxy;
  }
  return null;
}

/** Load (or reuse) a parsed document. Cached docs resolve instantly. */
export function loadDocument(url: string, onProgress?: ProgressFn): Promise<pdfjsLib.PDFDocumentProxy> {
  const existing = documents.get(url);
  if (existing) {
    existing.lastUsed = Date.now();
    if (onProgress) onProgress({ loaded: 1, total: 1 });
    return existing.promise;
  }

  const task = buildTask(url);
  if (onProgress) {
    task.onProgress = onProgress as any;
  }
  const promise = task.promise
    .then((p) => {
      const ent = documents.get(url);
      if (ent) ent.proxy = p;
      return p;
    })
    .catch((error) => {
      const ent = documents.get(url);
      if (ent?.promise === promise) documents.delete(url);
      try { task.destroy(); } catch { /* noop */ }
      throw error;
    });

  documents.set(url, { url, promise, lastUsed: Date.now() });
  evict();
  return promise;
}

export function invalidateDocument(url: string) {
  const entry = documents.get(url);
  if (!entry) return;
  documents.delete(url);
  const renderedPages = bitmaps.get(url);
  renderedPages?.forEach((value) => {
    try { value.bitmap.close?.(); } catch { /* noop */ }
  });
  bitmaps.delete(url);
  void entry.promise
    .then((proxy) => {
      try { proxy.destroy(); } catch { /* noop */ }
    })
    .catch(() => undefined);
}

/** Rendered-bitmap cache so re-opening a viewed page paints with zero delay. */
export function getRenderedBitmap(url: string, page: number) {
  const documentBitmaps = bitmaps.get(url);
  const cached = documentBitmaps?.get(page) || null;
  if (cached && documentBitmaps) {
    // Refresh insertion order so the least recently viewed bitmap is evicted.
    documentBitmaps.delete(page);
    documentBitmaps.set(page, cached);
  }
  return cached;
}

export function setRenderedBitmap(url: string, page: number, bitmap: ImageBitmap, w: number, h: number) {
  let m = bitmaps.get(url);
  if (!m) {
    m = new Map();
    bitmaps.set(url, m);
  }
  const old = m.get(page);
  if (old) { try { old.bitmap.close?.(); } catch { /* noop */ } }
  m.delete(page);
  m.set(page, { bitmap, w, h });

  while (m.size > MAX_BITMAPS_PER_DOC) {
    const oldestPage = m.keys().next().value as number | undefined;
    if (oldestPage === undefined) break;
    const oldest = m.get(oldestPage);
    m.delete(oldestPage);
    try { oldest?.bitmap.close?.(); } catch { /* noop */ }
  }
}
