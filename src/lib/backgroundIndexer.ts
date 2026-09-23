
import { get, set } from 'idb-keyval';
import * as pdfjsLib from 'pdfjs-dist';
import { buildIndexDirectly, PdfIndexItem } from './pdfIndexerService';
import { detectViewerSource, extractPdfText, getPdfProxyUrl } from './viewerUtils';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface CachedIndexData {
  items: PdfIndexItem[];
  fullText: { page: number, text: string }[];
  lastIndexed: string;
  indexVersion?: string;
  failed?: boolean;
  error?: string;
}

const INDEX_CACHE_VERSION = 'smart-v3';
const INDEX_CACHE_PREFIX = `pdf_index_${INDEX_CACHE_VERSION}_`;

export async function getCachedPdfData(docId: string): Promise<CachedIndexData | null> {
  try {
    return await get(`${INDEX_CACHE_PREFIX}${docId}`);
  } catch (e) {
    return null;
  }
}

export async function setCachedPdfData(docId: string, data: CachedIndexData): Promise<void> {
  try {
    await set(`${INDEX_CACHE_PREFIX}${docId}`, data);
  } catch (e) {
    console.warn('Failed to cache PDF data in IndexedDB', e);
  }
}

let isIndexing = false;
let stopRequested = false;

export function stopBackgroundIndexing() {
    stopRequested = true;
}

export async function startBackgroundIndexing(documents: any[]) {
  if (isIndexing) return;
  isIndexing = true;
  stopRequested = false;

  console.log(`[BackgroundIndexer] Starting indexing for ${documents.length} documents.`);

  // Yield until the browser is idle (or a short fallback) so each document is
  // indexed without stealing time from rendering / user interaction.
  const waitForIdle = () => new Promise<void>(resolve => {
    const ric = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    if (ric) ric(() => resolve(), { timeout: 4000 });
    else setTimeout(resolve, 1500);
  });

  for (const doc of documents) {
    if (stopRequested) break;
    await waitForIdle();
    if (stopRequested) break;
    
    // Skip if already indexed or if it's not a ready document
    if (doc.status !== 'ready' && doc.status !== 'published') continue;

    const source = detectViewerSource(doc.fileUrl || doc.externalUrl || '');
    if (source.type !== 'pdf-url') continue;
    
    const cached = await getCachedPdfData(doc.id);
    if (cached && !cached.failed) {
        // console.log(`[BackgroundIndexer] Skipping ${doc.title} - Already indexed.`);
        continue;
    }

    console.log(`[BackgroundIndexer] Indexing: ${doc.title}`);
    
    try {
      const proxiedUrl = getPdfProxyUrl(source.value);
      const absoluteUrl = proxiedUrl.startsWith('/') ? window.location.origin + proxiedUrl : proxiedUrl;
      // Encode URL to handle spaces and special characters which often cause "Invalid PDF structure" errors
      const encodedUrl = encodeURI(absoluteUrl);
      const loadingTask = pdfjsLib.getDocument(encodedUrl);
      const pdfDoc = await loadingTask.promise;
      
      // 1. Build Index (Outline/Auto)
      const items = await buildIndexDirectly(encodedUrl);
      
      // 2. Extract Full Text for instantaneous search later
      const fullText = await extractPdfText(pdfDoc);
      
      await setCachedPdfData(doc.id, {
        items,
        fullText,
        lastIndexed: new Date().toISOString(),
        indexVersion: INDEX_CACHE_VERSION
      });
      
      console.log(`[BackgroundIndexer] Finished: ${doc.title}`);
      
      // Clean up PDF resources
      await pdfDoc.destroy();
      
      // Short delay to keep UI responsive
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e: any) {
      console.info(`[BackgroundIndexer] Skipped ${doc.title}: ${e.message || e}`);
      // Mark as failed in cache so we don't try again immediately every refresh
      await setCachedPdfData(doc.id, {
        items: [],
        fullText: [],
        lastIndexed: new Date().toISOString(),
        indexVersion: INDEX_CACHE_VERSION,
        failed: true,
        error: e.message || String(e)
      });
    }
  }

  isIndexing = false;
  console.log(`[BackgroundIndexer] Background indexing completed.`);
}
