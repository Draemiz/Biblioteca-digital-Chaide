import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import HTMLFlipBook from 'react-pageflip';
import * as pdfjsLib from 'pdfjs-dist';
import { 
  Search as SearchIcon, 
  ChevronLeft, 
  ChevronRight, 
  Download, 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Minimize2, 
  X, 
  Home, 
  ArrowLeft, 
  Menu,
  ChevronUp, 
  ChevronDown, 
  List as ListIcon, 
  LayoutGrid,
  Library
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import { useStore } from '../../store/useStore';
import { formatFileSize, sortPdfDocumentsFirst } from '../../lib/viewerUtils';
import { getCachedPdfData, setCachedPdfData } from '../../lib/backgroundIndexer';
import { loadPersistedCatalogSearchIndex } from '../../lib/catalogSearchIndex';
import { buildIndexFromPdfDocument } from '../../lib/pdfIndexerService';
import {
  applyCatalogSpellingCorrections,
  buildCatalogVocabulary,
  catalogTypoDistance,
  resolveCatalogQueryTokens,
} from '../../lib/catalogAssistantSpelling';
import {
  loadDocument,
  getCachedDocument,
  getRenderedBitmap,
  invalidateDocument,
  setRenderedBitmap,
} from '../../lib/pdfCache';
import {
  PDF_DOCUMENT_ATTEMPTS,
  PDF_DOCUMENT_TIMEOUT_MS,
  PDF_PAGE_RENDER_ATTEMPTS,
  PDF_PAGE_RENDER_TIMEOUT_MS,
  isPdfCancellation,
  waitForRetry,
  withPdfTimeout,
} from '../../lib/pdfLoadGuard';
import CatalogPreviewCard from '../library/CatalogPreviewCard';
import CatalogViewerDetails from './CatalogViewerDetails';

// ... (previous imports and Page component remain same)

// Configure PDF.js worker - Use matching version
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SearchMatch {
  id: string;
  pageNumber: number;
  text: string;
  rects: HighlightRect[];
}

interface PdfIndexItem {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  source: "outline" | "auto" | "ocr";
  children?: PdfIndexItem[];
}

type IndexBuildResult = {
  status: "ready" | "empty" | "no-text" | "loading" | "error";
  items: PdfIndexItem[];
  source: "outline" | "auto" | "ocr" | null;
};

interface ProfessionalFlipbookProps {
  documentId: string;
  url: string;
  title: string;
  onClose?: () => void;
  downloadUrl?: string;
  initialPage?: number;
  initialSearch?: string;
  onPageChange?: (page: number) => void;
}

const SEARCH_FOCUS_ZOOM = 1.25;

function preserveCanvasAspectRatio(canvas: HTMLCanvasElement) {
  // The canvas bitmap already has the exact PDF viewport ratio. Let the
  // browser scale that bitmap uniformly instead of forcing both axes to 100%,
  // which can stretch catalog artwork when page boxes differ slightly.
  canvas.style.display = 'block';
  canvas.style.width = 'auto';
  canvas.style.height = 'auto';
  canvas.style.maxWidth = '100%';
  canvas.style.maxHeight = '100%';
  canvas.style.objectFit = 'contain';
  canvas.style.flex = '0 0 auto';
}

async function createCanvasSnapshotUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) return canvas.toDataURL('image/png');

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    // The browser can still display the object URL even when decode() is not
    // implemented or rejects for a transient scheduling reason.
  }
  return url;
}

function revokeCanvasSnapshotUrl(url: string | null) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

// Global render concurrency limiter for nearby background pages. Visible pages
// bypass this and render immediately; preloaded neighbours queue here so they
// cannot saturate the browser while the user is turning pages.
const MAX_CONCURRENT_RENDERS = 3;
let activeRenderCount = 0;
const renderWaiters: Array<() => void> = [];
function acquireRenderSlot(): Promise<void> {
  if (activeRenderCount < MAX_CONCURRENT_RENDERS) {
    activeRenderCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => renderWaiters.push(resolve));
}
function releaseRenderSlot() {
  const next = renderWaiters.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter (count unchanged)
  } else {
    activeRenderCount = Math.max(0, activeRenderCount - 1);
  }
}

// Robust Page Component
const PdfPage = React.forwardRef<HTMLDivElement, {
  number: number, 
  width: number, 
  height: number, 
  pdf: pdfjsLib.PDFDocumentProxy | null,
  highlights?: { rect: HighlightRect, isActive: boolean }[],
  isActiveMatchPage?: boolean,
  zoom: number,
  currentPage: number,
  backgroundRenderedPages?: Set<number>,
  docUrl?: string
}>((props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTaskRef = useRef<any>(null);
  const lastRenderScaleRef = useRef<number>(0);
  const isRenderingRef = useRef(false);
  // Bumped by the self-healing verifier to force a re-fetch / re-render of a
  // page that should be loaded but isn't yet (e.g. starved under heavy load).
  const [renderAttempt, setRenderAttempt] = useState(0);

  // A page is "active" (should be fetched + rendered) when it's in the visible
  // window OR once the aggressive full-document loader has unlocked it. Pages
  // are NEVER evicted: once rendered they stay loaded, so the whole document
  // ends up cached in memory for instant navigation (speed over memory).
  const WINDOW_BEHIND = 2;
  const WINDOW_AHEAD = 4;
  const inWindow =
    props.number <= 2 ||
    (props.number >= props.currentPage - WINDOW_BEHIND &&
      props.number <= props.currentPage + WINDOW_AHEAD);
  const isUnlocked = !!(props.backgroundRenderedPages && props.backgroundRenderedPages.has(props.number));
  const active = inWindow || isUnlocked;

  const [page, setPage] = useState<any>(null);

  // Fetch the page object (and its byte ranges, via pdf.js) once it becomes
  // active — this is the per-page, on-demand loading that then snowballs into
  // loading the whole document.
  useEffect(() => {
    if (!active || !props.pdf || page) return;

    let isCurrent = true;
    props.pdf.getPage(props.number).then((p: any) => {
      if (isCurrent) setPage(p);
    }).catch(err => console.warn(`Error getting page ${props.number}:`, err));

    return () => { isCurrent = false; };
  }, [active, props.pdf, props.number, page, renderAttempt]);

  // Self-healing verifier: while a page is active but still hasn't painted,
  // keep retrying (re-fetch + re-render) until it does. This guarantees no page
  // stays blank — if a render was starved or stalled under load, it is redone.
  useEffect(() => {
    if (!active || rendered) return;
    const id = window.setInterval(() => {
      if (!isRenderingRef.current && !rendered) {
        setRenderAttempt((a) => a + 1);
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [active, rendered]);

  // Instant paint from the persistent bitmap cache: if this exact page was
  // already rendered before (even in a previous viewing session of the same
  // catalog), draw the cached bitmap immediately so there is no spinner/flash.
  useLayoutEffect(() => {
    if (!active || rendered || !props.docUrl || !canvasRef.current) return;
    const cached = getRenderedBitmap(props.docUrl, props.number);
    if (!cached) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = cached.w;
    canvas.height = cached.h;
    preserveCanvasAspectRatio(canvas);
    try {
      ctx.drawImage(cached.bitmap, 0, 0);
      setRendered(true);
    } catch { /* fall back to normal render */ }
  }, [active, props.docUrl, props.number, rendered]);

  useEffect(() => {
    if (!active || !page || !canvasRef.current || props.width <= 0 || props.height <= 0) return;

    let isCurrent = true;

    // Visible/near pages render sharp and immediately; background pages render
    // lighter and go through the concurrency limiter so they never flood.
    const isPriorityPage =
      props.number === props.currentPage ||
      props.number === props.currentPage + 1 ||
      props.number === props.currentPage - 1 ||
      props.number === props.currentPage + 2 ||
      props.number <= 2;

    const render = async () => {
      const useLimiter = !isPriorityPage;
      if (useLimiter) await acquireRenderSlot();
      try {
        if (!isCurrent || !canvasRef.current) return;

        const baseViewport = page.getViewport({ scale: 1 });

        // Cap DPR at 2 to keep memory in check on high-density screens.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scaleByWidth = props.width / baseViewport.width;
        const scaleByHeight = props.height / baseViewport.height;
        const fitScale = Math.min(scaleByWidth, scaleByHeight);

        const zoomFactor = isPriorityPage ? Math.max(props.zoom, 1) : 1;
        const MAX_RENDER_SCALE = isPriorityPage ? 3.0 : 1.5;
        const renderScale = Math.min(fitScale * dpr * zoomFactor, MAX_RENDER_SCALE);

        // Skip redundant re-renders: same scale + already painted -> nothing to do.
        if (rendered && Math.abs(lastRenderScaleRef.current - renderScale) < 0.001) {
          return;
        }

        const viewport = page.getViewport({ scale: renderScale });
        if (!canvasRef.current || !isCurrent) return;

        const canvas = canvasRef.current;
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context || !isCurrent) return;

        context.imageSmoothingEnabled = true;
        (context as any).imageSmoothingQuality = 'high';
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        preserveCanvasAspectRatio(canvas);

        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* noop */ }
        }

        renderTaskRef.current = page.render({ canvasContext: context, viewport });
        isRenderingRef.current = true;
        await renderTaskRef.current.promise;
        renderTaskRef.current = null;

        if (isCurrent) {
          lastRenderScaleRef.current = renderScale;
          setRendered(true);
          // Persist the rendered bitmap so returning to this page (even after
          // leaving the viewer) repaints instantly from cache.
          if (props.docUrl && typeof createImageBitmap === 'function') {
            const w = canvas.width;
            const h = canvas.height;
            const docUrl = props.docUrl;
            const pageNum = props.number;
            createImageBitmap(canvas)
              .then((bmp) => setRenderedBitmap(docUrl, pageNum, bmp, w, h))
              .catch(() => undefined);
          }
        }
      } catch (err: any) {
        if (err.name !== 'RenderingCancelledException') {
          console.error('Page render error:', err);
        }
      } finally {
        isRenderingRef.current = false;
        if (useLimiter) releaseRenderSlot();
      }
    };

    // First paint: render immediately. Subsequent re-renders (e.g. while the
    // user pinches/zooms) are debounced — the parent already CSS-scales the page
    // for instant visual feedback, so we only need to re-rasterize for crispness
    // once the gesture settles. This avoids a re-render storm during zoom.
    let debounceTimer: number | null = null;
    if (!rendered) {
      render();
    } else {
      debounceTimer = window.setTimeout(render, 160);
    }

    return () => {
      isCurrent = false;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
    };
  }, [page, active, props.width, props.height, props.zoom, props.currentPage, renderAttempt]);

  return (
    <div
      className="bg-white shadow-lg overflow-hidden flex items-center justify-center relative page-container border-r border-gray-100 last:border-none" 
      ref={ref} 
      data-density={props.number === 1 ? "hard" : "soft"}
    >
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50/50">
          <div className="w-6 h-6 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}
      
      <div className="relative w-full h-full flex items-center justify-center">
        <canvas ref={canvasRef} className="pdf-page-canvas" />
        
        {/* Highlight Layer */}
        {rendered && props.highlights && props.highlights.length > 0 && (
          <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
            <div className="relative w-full h-full">
              {props.highlights.map((h, idx) => (
                <div 
                  key={idx}
                  className={cn(
                    "absolute transition-all duration-300 rounded-sm",
                    h.isActive 
                      ? "bg-orange-400/60 ring-2 ring-orange-500 ring-offset-1 z-20 scale-105" 
                      : "bg-yellow-400/40 border border-yellow-600/30 z-10"
                  )}
                  style={{
                    left: `${h.rect.left}%`,
                    top: `${h.rect.top}%`,
                    width: `${h.rect.width}%`,
                    height: `${h.rect.height}%`
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-4 right-6 text-[10px] font-medium text-gray-300 select-none z-20">
        {props.number}
      </div>
    </div>
  );
});

type QueuedPdfPageElement = HTMLDivElement & {
  ensurePdfPage?: () => void;
};

type QueuedPdfPageProps = {
  number: number;
  width: number;
  height: number;
  pdf: pdfjsLib.PDFDocumentProxy | null;
  highlights?: { rect: HighlightRect; isActive: boolean }[];
  isActiveMatchPage?: boolean;
  zoom: number;
  eager: boolean;
  priority: boolean;
  docUrl?: string;
  onRendered?: (pageNumber: number) => void;
};

const QueuedPdfPageBase = React.forwardRef<HTMLDivElement, QueuedPdfPageProps>((props, ref) => {
  const rootRef = useRef<QueuedPdfPageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryCycleRef = useRef(0);
  const lastRenderScaleRef = useRef(0);
  const isRenderingRef = useRef(false);
  const renderedRef = useRef(false);
  const [forcedActive, setForcedActive] = useState(false);
  const [page, setPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
  const [rendered, setRendered] = useState(false);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const pageImageUrlRef = useRef<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderTry, setRenderTry] = useState(0);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const active = props.eager || forcedActive;

  const replacePageImage = useCallback((nextUrl: string | null) => {
    const previousUrl = pageImageUrlRef.current;
    pageImageUrlRef.current = nextUrl;
    setPageImageUrl(nextUrl);
    if (previousUrl !== nextUrl) revokeCanvasSnapshotUrl(previousUrl);
  }, []);

  const setRootNode = useCallback((node: QueuedPdfPageElement | null) => {
    rootRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
    } else if (ref) {
      ref.current = node;
    }
  }, [ref]);

  useEffect(() => {
    renderedRef.current = rendered;
    if (rootRef.current) {
      rootRef.current.dataset.pdfRendered = rendered ? 'true' : 'false';
    }
  }, [rendered]);

  useEffect(() => {
    if (props.eager) {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      return;
    }
    if (!forcedActive) return;
    // Never cancel a heavy neighbour while it is still painting. Previously
    // the fixed 1.5 s release could abort complex pages repeatedly.
    if (!rendered) return;
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      setForcedActive(false);
    }, 1500);
    return () => {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };
  }, [forcedActive, props.eager, rendered]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    node.ensurePdfPage = () => {
      if (renderedRef.current || isRenderingRef.current) return;
      setForcedActive(true);
      setRenderError(null);
      setRenderAttempt((attempt) => attempt + 1);
    };

    return () => {
      delete node.ensurePdfPage;
    };
  }, []);

  useEffect(() => {
    if (active) return;
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryCycleRef.current = 0;
    renderTaskRef.current?.cancel?.();
    renderTaskRef.current = null;
    isRenderingRef.current = false;
    lastRenderScaleRef.current = 0;
    setPage(null);
    setRendered(false);
    replacePageImage(null);
    setRenderError(null);
    setRenderTry(0);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }, [active, replacePageImage]);

  useEffect(() => () => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
    }
    revokeCanvasSnapshotUrl(pageImageUrlRef.current);
    pageImageUrlRef.current = null;
  }, []);

  useEffect(() => {
    if (!active || !props.pdf || page) return;

    let current = true;
    const getPage = async () => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= PDF_PAGE_RENDER_ATTEMPTS && current; attempt++) {
        setRenderTry(attempt);
        try {
          const pdfPage = await withPdfTimeout(
            props.pdf!.getPage(props.number),
            PDF_PAGE_RENDER_TIMEOUT_MS,
            `La página ${props.number}`,
          );
          if (current) {
            setPage(pdfPage);
            setRenderError(null);
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt < PDF_PAGE_RENDER_ATTEMPTS) await waitForRetry(attempt);
        }
      }
      if (!current) return;
      const message = lastError instanceof Error ? lastError.message : 'No se pudo leer esta página.';
      setRenderError(message);
      recoveryCycleRef.current += 1;
      const recoveryDelay = Math.min(2500 * 2 ** (recoveryCycleRef.current - 1), 15_000);
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (!current) return;
        setRenderError(null);
        setRenderAttempt((attempt) => attempt + 1);
      }, recoveryDelay);
    };
    void getPage();

    return () => {
      current = false;
    };
  }, [active, page, props.number, props.pdf, renderAttempt]);

  useLayoutEffect(() => {
    if (!active || rendered || !props.docUrl || !canvasRef.current) return;
    const cached = getRenderedBitmap(props.docUrl, props.number);
    if (!cached) return;

    const context = canvasRef.current.getContext('2d');
    if (!context) return;

    canvasRef.current.width = cached.w;
    canvasRef.current.height = cached.h;
    preserveCanvasAspectRatio(canvasRef.current);

    let current = true;
    try {
      context.drawImage(cached.bitmap, 0, 0);
      void createCanvasSnapshotUrl(canvasRef.current).then((snapshotUrl) => {
        if (!current) {
          revokeCanvasSnapshotUrl(snapshotUrl);
          return;
        }
        replacePageImage(snapshotUrl);
        setRendered(true);
        props.onRendered?.(props.number);
      });
    } catch {
      // The bitmap may have been evicted between lookup and paint.
    }
    return () => { current = false; };
  }, [active, props.docUrl, props.number, props.onRendered, rendered, replacePageImage]);

  useEffect(() => {
    if (!active || !page || !canvasRef.current || props.width <= 0 || props.height <= 0) return;

    let current = true;
    let debounceTimer: number | null = null;

    const render = async () => {
      const useLimiter = !props.priority;
      if (useLimiter) await acquireRenderSlot();

      try {
        if (!current || !canvasRef.current) return;

        // pdf.js keeps ownership of a canvas until a cancelled render promise
        // has actually settled. Wait for the previous task before reusing the
        // same canvas when page priority changes during navigation.
        const previousTask = renderTaskRef.current;
        if (previousTask) {
          try { previousTask.cancel?.(); } catch { /* noop */ }
          try { await previousTask.promise; } catch { /* cancellation expected */ }
          if (renderTaskRef.current === previousTask) renderTaskRef.current = null;
        }
        if (!current || !canvasRef.current) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const fitScale = Math.min(
          props.width / baseViewport.width,
          props.height / baseViewport.height,
        );
        const renderScale = Math.min(
          fitScale * dpr * (props.priority ? Math.max(props.zoom, 1) : 1),
          props.priority ? 3 : 1.35,
        );

        if (rendered && Math.abs(lastRenderScaleRef.current - renderScale) < 0.001) return;

        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context || !current) return;

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        preserveCanvasAspectRatio(canvas);

        setRenderError(null);
        isRenderingRef.current = true;
        let completed = false;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= PDF_PAGE_RENDER_ATTEMPTS && current; attempt++) {
          setRenderTry(attempt);
          let attemptTask: any = null;
          try {
            const task = page.render({ canvasContext: context, viewport });
            attemptTask = task;
            renderTaskRef.current = task;
            await withPdfTimeout(
              task.promise,
              PDF_PAGE_RENDER_TIMEOUT_MS,
              `La página ${props.number}`,
              () => task.cancel?.(),
            );
            if (renderTaskRef.current === task) renderTaskRef.current = null;
            completed = true;
            break;
          } catch (error) {
            lastError = error;
            const failedTask = attemptTask;
            if (failedTask) {
              try { await failedTask.promise; } catch { /* already reported below */ }
              if (renderTaskRef.current === failedTask) renderTaskRef.current = null;
            }
            if (!current || isPdfCancellation(error)) return;
            if (attempt < PDF_PAGE_RENDER_ATTEMPTS) await waitForRetry(attempt);
          }
        }

        if (!completed) throw lastError || new Error(`No se pudo dibujar la página ${props.number}.`);

        if (!current) return;

        const snapshotUrl = await createCanvasSnapshotUrl(canvas);
        if (!current) {
          revokeCanvasSnapshotUrl(snapshotUrl);
          return;
        }

        lastRenderScaleRef.current = renderScale;
        replacePageImage(snapshotUrl);
        setRendered(true);
        props.onRendered?.(props.number);
        setRenderTry(0);
        recoveryCycleRef.current = 0;

        if (props.docUrl && typeof createImageBitmap === 'function') {
          const width = canvas.width;
          const height = canvas.height;
          void createImageBitmap(canvas)
            .then((bitmap) => setRenderedBitmap(props.docUrl!, props.number, bitmap, width, height))
            .catch(() => undefined);
        }
      } catch (error: any) {
        if (!isPdfCancellation(error)) {
          console.error(`Page ${props.number} render error:`, error);
          if (current) {
            setRenderError(error instanceof Error ? error.message : 'No se pudo cargar esta página.');
            recoveryCycleRef.current += 1;
            const recoveryDelay = Math.min(2500 * 2 ** (recoveryCycleRef.current - 1), 15_000);
            recoveryTimerRef.current = window.setTimeout(() => {
              recoveryTimerRef.current = null;
              if (!current) return;
              setRenderError(null);
              setRenderAttempt((attempt) => attempt + 1);
            }, recoveryDelay);
          }
        }
      } finally {
        isRenderingRef.current = false;
        if (useLimiter) releaseRenderSlot();
      }
    };

    if (rendered) {
      debounceTimer = window.setTimeout(render, 140);
    } else {
      void render();
    }

    return () => {
      current = false;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      renderTaskRef.current?.cancel?.();
    };
  }, [
    active,
    page,
    props.docUrl,
    props.height,
    props.number,
    props.onRendered,
    props.priority,
    props.width,
    props.zoom,
    replacePageImage,
    renderAttempt,
    rendered,
  ]);

  return (
    <div
      ref={setRootNode}
      className="bg-white shadow-lg overflow-hidden flex items-center justify-center relative page-container border-r border-gray-100 last:border-none"
      data-density={props.number === 1 ? 'hard' : 'soft'}
      data-pdf-page={props.number}
      data-pdf-rendered={rendered ? 'true' : 'false'}
    >
      {active && renderError ? (
        <div className="absolute inset-0 z-20 flex flex-col gap-3 items-center justify-center bg-red-50/95 px-6 text-center">
          <div className="w-7 h-7 border-2 border-red-200 border-t-red-500 rounded-full animate-spin" />
          <strong className="text-xs text-gray-900">Recuperando la página {props.number}…</strong>
          <span className="max-w-xs text-[10px] text-gray-500">{renderError}</span>
          <span className="text-[9px] font-semibold text-red-500">
            Reintento automático en curso
          </span>
        </div>
      ) : active && !rendered ? (
        <div className="absolute inset-0 flex flex-col gap-3 items-center justify-center bg-gray-50/90">
          <div className="w-7 h-7 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-[10px] font-semibold tracking-wide text-gray-400">
            Cargando página {props.number}…
          </span>
          {renderTry > 1 ? (
            <span className="text-[9px] text-gray-400">
              Reintento {renderTry} de {PDF_PAGE_RENDER_ATTEMPTS}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="relative w-full h-full flex items-center justify-center">
        <canvas
          ref={canvasRef}
          className={cn('pdf-page-canvas', pageImageUrl && 'invisible absolute inset-0')}
        />
        {pageImageUrl ? (
          <img
            src={pageImageUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pdf-page-snapshot block h-auto w-auto max-h-full max-w-full object-contain select-none"
          />
        ) : null}

        {rendered && props.highlights && props.highlights.length > 0 ? (
          <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
            <div className="relative w-full h-full">
              {props.highlights.map((highlight, index) => (
                <div
                  key={index}
                  className={cn(
                    'absolute transition-all duration-300 rounded-sm',
                    highlight.isActive
                      ? 'bg-orange-400/60 ring-2 ring-orange-500 ring-offset-1 z-20 scale-105'
                      : 'bg-yellow-400/40 border border-yellow-600/30 z-10',
                  )}
                  style={{
                    left: `${highlight.rect.left}%`,
                    top: `${highlight.rect.top}%`,
                    width: `${highlight.rect.width}%`,
                    height: `${highlight.rect.height}%`,
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="absolute bottom-4 right-6 text-[10px] font-medium text-gray-300 select-none z-20">
        {props.number}
      </div>
    </div>
  );
});

const QueuedPdfPage = React.memo(QueuedPdfPageBase, (previous, next) => {
  const previousHighlights = previous.highlights || [];
  const nextHighlights = next.highlights || [];
  const highlightsUnchanged =
    previousHighlights === nextHighlights ||
    (previousHighlights.length === 0 && nextHighlights.length === 0);

  return (
    previous.number === next.number &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.pdf === next.pdf &&
    previous.zoom === next.zoom &&
    previous.eager === next.eager &&
    previous.priority === next.priority &&
    previous.docUrl === next.docUrl &&
    previous.isActiveMatchPage === next.isActiveMatchPage &&
    highlightsUnchanged
  );
});

type FlipbookPageState = {
  currentPage: number;
  renderFocusPage: number | null;
  prefetchPages: Set<number>;
  turningPages: Set<number>;
  numPages: number;
  zoom: number;
  highlightsVisible: boolean;
  searchResults: SearchMatch[];
  activeMatchIndex: number;
};

const FlipbookPageContext = React.createContext<FlipbookPageState | null>(null);

// Keep the PageFlip child elements stable. Live rendering priorities travel
// through context, so repainting a PDF page does not make react-pageflip
// rebuild the entire book (which interrupts an in-progress page turn).
const FlipbookPage = React.forwardRef<HTMLDivElement, Omit<QueuedPdfPageProps, 'zoom' | 'eager' | 'priority' | 'highlights' | 'isActiveMatchPage'>>((props, ref) => {
  const state = React.useContext(FlipbookPageContext);
  if (!state) return null;
  const centerPage = (state.renderFocusPage ?? state.currentPage) + 1;
  const visiblePages = centerPage > 1
    ? [centerPage, Math.min(centerPage + 1, state.numPages)]
    : [centerPage];
  const priority = visiblePages.includes(props.number);
  const eager = priority || state.prefetchPages.has(props.number) || state.turningPages.has(props.number);
  const highlights = state.highlightsVisible
    ? state.searchResults
      .filter((result) => result.pageNumber === props.number)
      .flatMap((result) => result.rects.map((rect) => ({
        rect,
        isActive: state.activeMatchIndex !== -1 && state.searchResults[state.activeMatchIndex] === result,
      })))
    : undefined;

  return (
    <QueuedPdfPage
      {...props}
      ref={ref}
      zoom={state.zoom}
      eager={eager}
      priority={priority}
      highlights={highlights}
      isActiveMatchPage={state.activeMatchIndex !== -1 && state.searchResults[state.activeMatchIndex]?.pageNumber === props.number}
    />
  );
});

// THUMBNAIL COMPONENT (Optimized with cache support)
interface ThumbnailProps {
  pdf: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  cache: Map<number, string>;
  onThumbnailRendered?: (pageNumber: number, dataUrl: string) => void;
}

const PdfPageThumbnail = ({ pdf, pageNumber, cache, onThumbnailRendered }: ThumbnailProps) => {
  const cachedImg = cache.get(pageNumber);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (cachedImg || !pdf || !canvasRef.current) return;
    
    let isCurrent = true;
    const render = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 0.15 });
        const canvas = canvasRef.current!;
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;
        
        if (isCurrent) {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
          onThumbnailRendered?.(pageNumber, dataUrl);
        }
      } catch (err) { }
    };
    render();
    return () => { isCurrent = false; };
  }, [pdf, pageNumber, cachedImg, onThumbnailRendered]);

  if (cachedImg) {
    return <img src={cachedImg} alt={`Página ${pageNumber}`} className="w-full h-full object-contain" />;
  }
  return <canvas ref={canvasRef} className="pdf-thumbnail-canvas w-full h-full object-contain" />;
};

const LazyPdfPageThumbnail = ({ pdf, pageNumber, cache, onThumbnailRendered }: ThumbnailProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isCached = cache.has(pageNumber);

  useEffect(() => {
    if (isCached) {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isCached]);

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-gray-50 overflow-hidden">
      {isVisible || isCached ? (
        <PdfPageThumbnail 
          pdf={pdf} 
          pageNumber={pageNumber} 
          cache={cache} 
          onThumbnailRendered={onThumbnailRendered}
        />
      ) : (
        <div className="w-4 h-4 border-2 border-gray-100 border-t-blue-500 rounded-full animate-spin" />
      )}
    </div>
  );
};

export default function ProfessionalFlipbook({ documentId, url, title, onClose, downloadUrl, initialPage, initialSearch, onPageChange }: ProfessionalFlipbookProps) {
  const navigate = useNavigate();
  const { documents } = useStore();
  const currentDoc = useMemo(() => {
    return documents.find((document) => document.id === documentId);
  }, [documentId, documents]);

  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [docCacheKey, setDocCacheKey] = useState<string>('');
  const [numPages, setNumPages] = useState(0);
  const [pdfPageSize, setPdfPageSize] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(0); // 0-based for flipbook
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readyToRender, setReadyToRender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState({ x: '50%', y: '50%' });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  // While a page turn is being prepared, render the destination spread first.
  // Without this separate focus, react-pageflip can reveal an inactive 1x1
  // canvas and leave an apparently blank page on large catalogues.
  const [renderFocusPage, setRenderFocusPage] = useState<number | null>(null);
  const [turningPages, setTurningPages] = useState<Set<number>>(new Set());
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());
  const [prefetchPages, setPrefetchPages] = useState<Set<number>>(new Set());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // NOTE: The eager full-document thumbnail preloader was removed. Thumbnails
  // are now rendered lazily on demand by LazyPdfPageThumbnail (IntersectionObserver)
  // only when the thumbnail panel is opened, avoiding a second full render pass.

  const [containerSize, setContainerSize] = useState({
    width: 0, 
    height: 0 
  });
  
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const activePointers = useRef<Map<number, {
    x: number;
    y: number;
    currentX: number;
    currentY: number;
    time: number;
  }>>(new Map());
  const lastTapRef = useRef<{ x: number, y: number, time: number } | null>(null);
  const singleTapTimerRef = useRef<number | null>(null);
  const navigationUnlockTimerRef = useRef<number | null>(null);
  const navigationRetryTimerRef = useRef<number | null>(null);
  const documentRecoveryTimerRef = useRef<number | null>(null);
  const documentRecoveryCycleRef = useRef(0);
  const navigationLockedRef = useRef(false);
  const initialTargetRef = useRef('');
  const lastReportedPageRef = useRef<number | null>(null);
  const isSwipingRef = useRef(false);
  const isPanningRef = useRef(false);
  const startPanRef = useRef({ x: 0, y: 0 });
  const lastPanRef = useRef({ x: 0, y: 0 });
  const initialTouchDistanceRef = useRef<number | null>(null);
  const initialZoomRef = useRef(1);

  const DOUBLE_TAP_MAX_DELAY = 330;
  const DOUBLE_TAP_MAX_DISTANCE = 48;
  const TAP_MAX_MOVEMENT = 30;
  const SWIPE_MIN_DISTANCE = 45;
  const SWIPE_MAX_VERTICAL_DRIFT = 35;
  const EDGE_ZONE_RATIO = 0.2;
  const MAX_ZOOM = 2.5;
  const MIN_ZOOM = 1;
  const DOUBLE_TAP_ZOOM = 1.8;

  const isInteractiveElement = (target: any) => {
    return !!target?.closest('button, input, a, [role="button"], .pdf-toolbar, .pdf-search-panel');
  };

  const getTapZone = (clientX: number) => {
    if (!mainAreaRef.current) return 'center';
    const rect = mainAreaRef.current.getBoundingClientRect();
    const relativeX = (clientX - rect.left) / rect.width;
    if (relativeX < EDGE_ZONE_RATIO) return 'left';
    if (relativeX > 1 - EDGE_ZONE_RATIO) return 'right';
    return 'center';
  };

  const clearPendingSingleTap = () => {
    if (singleTapTimerRef.current) {
      window.clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  };

  const clearNavigationLock = useCallback(() => {
    navigationLockedRef.current = false;
    if (navigationUnlockTimerRef.current !== null) {
      window.clearTimeout(navigationUnlockTimerRef.current);
      navigationUnlockTimerRef.current = null;
    }
  }, []);

  const beginNavigation = useCallback(() => {
    if (navigationLockedRef.current) return false;
    navigationLockedRef.current = true;
    navigationUnlockTimerRef.current = window.setTimeout(clearNavigationLock, 6500);
    return true;
  }, [clearNavigationLock]);

  useEffect(() => () => {
    clearPendingSingleTap();
    clearNavigationLock();
    if (navigationRetryTimerRef.current !== null) {
      window.clearTimeout(navigationRetryTimerRef.current);
    }
    if (documentRecoveryTimerRef.current !== null) {
      window.clearTimeout(documentRecoveryTimerRef.current);
    }
    activePointers.current.clear();
  }, [clearNavigationLock]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isInteractiveElement(e.target)) return;
    
    activePointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      time: Date.now()
    });

    if (activePointers.current.size === 1) {
      if (isMobile && isIndexOpen) {
        setIsIndexOpen(false);
      }
      startPanRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      isPanningRef.current = false;
      isSwipingRef.current = false;
    } else if (activePointers.current.size === 2) {
      clearPendingSingleTap();
      const docs = Array.from(activePointers.current.values());
      if (docs.length < 2) return;
      initialTouchDistanceRef.current = Math.hypot(docs[0].x - docs[1].x, docs[0].y - docs[1].y);
      initialZoomRef.current = zoom;
      
      if (zoom <= 1.01) {
        const cx = (docs[0].x + docs[1].x) / 2;
        const cy = (docs[0].y + docs[1].y) / 2;
        const containerElement = e.currentTarget as HTMLElement;
        const spreadElement = containerElement.querySelector('.pdf-book-spread') as HTMLElement;
        const rect = spreadElement ? spreadElement.getBoundingClientRect() : containerElement.getBoundingClientRect();
        
        const originX = Math.max(0, Math.min(100, ((cx - rect.left) / rect.width) * 100));
        const originY = Math.max(0, Math.min(100, ((cy - rect.top) / rect.height) * 100));
        setZoomOrigin({ x: `${originX}%`, y: `${originY}%` });
      }
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = activePointers.current.get(e.pointerId);
    if (!start) return;

    // Update current position for this pointer
    activePointers.current.set(e.pointerId, {
      ...start,
      currentX: e.clientX,
      currentY: e.clientY
    });

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (activePointers.current.size === 1) {
      if (zoom > 1) {
        if (Math.abs(dx) > TAP_MAX_MOVEMENT || Math.abs(dy) > TAP_MAX_MOVEMENT) {
          if (!isPanningRef.current) {
            isPanningRef.current = true;
            setIsPanning(true);
          }
          setPan({
            x: e.clientX - startPanRef.current.x,
            y: e.clientY - startPanRef.current.y
          });
        }
      } else {
        if (Math.abs(dx) > SWIPE_MIN_DISTANCE && Math.abs(dy) < SWIPE_MAX_VERTICAL_DRIFT) {
          isSwipingRef.current = true;
        }
      }
    } else if (activePointers.current.size === 2 && initialTouchDistanceRef.current) {
      const docs = Array.from(activePointers.current.values());
      if (docs.length < 2) return;
      const currentDistance = Math.hypot(docs[0].currentX - docs[1].currentX, docs[0].currentY - docs[1].currentY);
      const scale = currentDistance / initialTouchDistanceRef.current;
      const newZoom = Math.min(Math.max(initialZoomRef.current * scale, 1), 2.5);
      setZoom(newZoom);
      if (newZoom <= 1.01) {
        setPan({ x: 0, y: 0 });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const start = activePointers.current.get(e.pointerId);
    if (!start) return;

    activePointers.current.delete(e.pointerId);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

    // If we drop from 2 pointers to 1 pointer, we must reset the pan starting point for the remaining pointer
    if (activePointers.current.size === 1) {
      const remainingDoc = Array.from(activePointers.current.values())[0];
      startPanRef.current = {
        x: remainingDoc.currentX - pan.x,
        y: remainingDoc.currentY - pan.y
      };
      // Explicitly return to skip tap/swipe logic for a pinch-ended gesture
      return;
    }

    const dx = e.clientX - start.x;
    const movement = Math.hypot(dx, e.clientY - start.y);
    const now = Date.now();

    if (isPanningRef.current) {
      if (activePointers.current.size === 0) {
        setIsPanning(false);
        isPanningRef.current = false;
      }
      return;
    }

    if (isSwipingRef.current) {
      isSwipingRef.current = false;
      if (zoom <= 1) {
        if (dx < -SWIPE_MIN_DISTANCE) {
          goToNextPage(true);
        } else if (dx > SWIPE_MIN_DISTANCE) {
          goToPreviousPage(true);
        }
      }
      return;
    }

    if (movement > TAP_MAX_MOVEMENT) return;

    // Tap Handling
    const zone = getTapZone(e.clientX);
    const isDoubleTap = 
      lastTapRef.current && 
      (now - lastTapRef.current.time) < DOUBLE_TAP_MAX_DELAY &&
      Math.hypot(e.clientX - lastTapRef.current.x, e.clientY - lastTapRef.current.y) < DOUBLE_TAP_MAX_DISTANCE;

    if (isDoubleTap) {
      clearPendingSingleTap();
      
      // Allow double tap zoom anywhere
      toggleZoomAtPoint(e.clientX, e.clientY, e.currentTarget as HTMLElement);
      lastTapRef.current = null;
      return;
    }

    lastTapRef.current = { x: e.clientX, y: e.clientY, time: now };
    clearPendingSingleTap();

    singleTapTimerRef.current = window.setTimeout(() => {
      if (zoom <= 1) {
        if (zone === 'right') {
          goToNextPage(true);
        } else if (zone === 'left') {
          goToPreviousPage(true);
        }
      }
      lastTapRef.current = null;
    }, DOUBLE_TAP_MAX_DELAY);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [highlightsVisible, setHighlightsVisible] = useState(false);
  const [fullText, setFullText] = useState<{ page: number, text: string }[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [indexItems, setIndexItems] = useState<PdfIndexItem[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexBuildResult['status']>('empty');
  const [indexSource, setIndexSource] = useState<IndexBuildResult['source']>(null);
  const [expandedIndexItems, setExpandedIndexItems] = useState<Set<string>>(new Set());
  const [isIndexOpen, setIsIndexOpen] = useState(false);
  const [isThumbnailPanelOpen, setIsThumbnailPanelOpen] = useState(false);
  const [thumbnailCache, setThumbnailCache] = useState<Map<number, string>>(new Map());
  const [pageInput, setPageInput] = useState('1');

  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isSearchResultsSheetOpen, setIsSearchResultsSheetOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const toggleZoomAtPoint = useCallback((clientX: number, clientY: number, containerElement: HTMLElement) => {
    setZoom(prevZoom => {
      const nextZoom = prevZoom > 1 ? 1 : DOUBLE_TAP_ZOOM;
      
      if (nextZoom === 1) {
        setZoomOrigin({ x: '50%', y: '50%' });
        setPan({ x: 0, y: 0 });
      } else {
        const spreadElement = containerElement.querySelector('.pdf-book-spread') || containerElement.querySelector('.pdf-stage');
        const rect = spreadElement ? (spreadElement as HTMLElement).getBoundingClientRect() : containerElement.getBoundingClientRect();
        
        const originX = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        const originY = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
        setZoomOrigin({ x: `${originX}%`, y: `${originY}%` });
      }
      return nextZoom;
    });
  }, [DOUBLE_TAP_ZOOM]);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const openMobileSearch = () => {
    setIsMobileSearchOpen(true);
    setTimeout(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }, 50);
  };

  const closeMobileSearch = () => {
    setIsMobileSearchOpen(false);
    setIsSearchResultsSheetOpen(false);
  };

  const submitMobileSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) return;

    const results = await performSearch(query);
    if (results && results.length > 0) {
      setIsSearchResultsSheetOpen(true);
    }
  };

  const nextMatchMobile = () => {
    if (searchResults.length === 0) return;
    const nextIdx = (activeMatchIndex + 1) % searchResults.length;
    setActiveMatchIndex(nextIdx);
    goToPage(searchResults[nextIdx].pageNumber);
  };

  const prevMatchMobile = () => {
    if (searchResults.length === 0) return;
    const prevIdx = (activeMatchIndex - 1 + searchResults.length) % searchResults.length;
    setActiveMatchIndex(prevIdx);
    goToPage(searchResults[prevIdx].pageNumber);
  };

  // Sync isSearchResultsSheetOpen with searchResults on mobile
  useEffect(() => {
    if (isMobileSearchOpen && searchResults.length > 0) {
      setIsSearchResultsSheetOpen(true);
    }
  }, [searchResults.length, isMobileSearchOpen]);

  // Load PDF
  useEffect(() => {
    let isMounted = true;

    const loadDoc = async () => {
      clearNavigationLock();
      if (navigationRetryTimerRef.current !== null) {
        window.clearTimeout(navigationRetryTimerRef.current);
        navigationRetryTimerRef.current = null;
      }
      initialTargetRef.current = '';
      setCurrentPage(0);
      setRenderFocusPage(null);
      setPageInput('1');
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setZoomOrigin({ x: '50%', y: '50%' });
      setSearchQuery('');
      setSearchResults([]);
      setActiveMatchIndex(-1);
      setHighlightsVisible(false);
      setFullText([]);
      setIndexItems([]);
      setIndexStatus('empty');
      setIndexSource(null);
      setExpandedIndexItems(new Set());
      setThumbnailCache(new Map());
      setLoading(true);
      setLoadAttempt(1);
      setError(null);
      setLoadProgress(0);
      setReadyToRender(false);
      setRenderedPages(new Set());
      setPrefetchPages(new Set());
      setPdf(null);
      setNumPages(0);
      try {
        // Enforce absolute URL for PDF.js loading
        if (!url || typeof url !== 'string') throw new Error("URL de PDF no válida");
        const absoluteUrl = url.startsWith('/') ? window.location.origin + url : url;
        setDocCacheKey(absoluteUrl);
        console.log('Iniciando carga de PDF:', absoluteUrl);

        // Reuse a previously parsed document if the user already opened this
        // catalog — no re-download, no re-parse. Otherwise load + cache it. The
        // cache survives leaving/returning to the viewer.
        const cachedNow = getCachedDocument(absoluteUrl);
        if (cachedNow) setLoadProgress(100);

        let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
        let lastLoadError: unknown = null;
        for (let attempt = 1; attempt <= PDF_DOCUMENT_ATTEMPTS && isMounted; attempt++) {
          setLoadAttempt(attempt);
          try {
            pdfDoc = await withPdfTimeout(
              loadDocument(absoluteUrl, (progress) => {
                if (progress.total > 0) {
                  const percent = Math.round((progress.loaded / progress.total) * 100);
                  if (isMounted) setLoadProgress(percent);
                }
              }),
              PDF_DOCUMENT_TIMEOUT_MS,
              'El catálogo',
              () => invalidateDocument(absoluteUrl),
            );
            break;
          } catch (loadError) {
            lastLoadError = loadError;
            invalidateDocument(absoluteUrl);
            if (attempt < PDF_DOCUMENT_ATTEMPTS) {
              setLoadProgress(0);
              await waitForRetry(attempt);
            }
          }
        }
        if (!pdfDoc) throw lastLoadError || new Error('No se pudo abrir el catálogo.');
        console.log('PDF cargado con éxito. Páginas:', pdfDoc.numPages);
        
        if (!isMounted) return;

        // Get actual page size from first page
        const firstPage = await pdfDoc.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        setPdfPageSize({ width: viewport.width, height: viewport.height });
        
        setPdf(pdfDoc);
        setNumPages(pdfDoc.numPages);
        setLoading(false);
        documentRecoveryCycleRef.current = 0;

        // Reuse existing metadata without starting OCR or parsing every page.
        if (currentDoc) {
          if (currentDoc.indexItems && currentDoc.indexItems.length > 0) {
            setIndexItems(currentDoc.indexItems);
            setIndexSource(currentDoc.indexItems[0]?.source || 'auto');
            setIndexStatus('ready');
          }

          getCachedPdfData(currentDoc.id).then(cached => {
            if (cached && isMountedRef.current) {
              if (cached.items && cached.items.length > 0) {
                setIndexItems(cached.items);
                setIndexStatus('ready');
                setIndexSource(cached.items[0].source);
              }
              if (cached.fullText && cached.fullText.length > 0) {
                setFullText(cached.fullText);
              }
            }
          });

          loadPersistedCatalogSearchIndex(currentDoc).then((pages) => {
            if (!isMountedRef.current || pages.length === 0) return;
            const persistedText = pages.map((page) => ({
              page: page.pageNumber,
              text: page.text,
            }));
            setFullText(persistedText);
            void setCachedPdfData(currentDoc.id, {
              items: currentDoc.indexItems || [],
              fullText: persistedText,
              lastIndexed: new Date().toISOString(),
              indexVersion: currentDoc.searchIndexVersion || 'persisted',
            });
          }).catch(() => undefined);
        }

        // Thumbnails are now rendered lazily on demand (LazyPdfPageThumbnail
        // with IntersectionObserver) when the thumbnail panel is opened, so we
        // no longer eagerly pre-render every page's thumbnail here. This avoids
        // a second full-document render pass competing with the main viewer.
      } catch (err: any) {
        console.error('PDF load error:', err);
        if (isMounted) {
          const detail = err.message || 'Error desconocido';
          setError(`No se pudo visualizar el PDF. ${detail}. Verifique el enlace o la configuración de CORS.`);
          setLoading(true);
          documentRecoveryCycleRef.current += 1;
          const recoveryDelay = Math.min(
            5000 * 2 ** (documentRecoveryCycleRef.current - 1),
            30_000,
          );
          documentRecoveryTimerRef.current = window.setTimeout(() => {
            documentRecoveryTimerRef.current = null;
            if (isMounted) setReloadToken((token) => token + 1);
          }, recoveryDelay);
        }
      }
    };

    if (url) loadDoc();
    return () => {
      isMounted = false;
      if (documentRecoveryTimerRef.current !== null) {
        window.clearTimeout(documentRecoveryTimerRef.current);
        documentRecoveryTimerRef.current = null;
      }
      // Intentionally DO NOT destroy the document here: the shared pdfCache
      // keeps it (and its rendered bitmaps) alive so returning to this catalog
      // is instant. The cache's LRU handles eventual cleanup.
    };
  }, [documentId, url, reloadToken, clearNavigationLock]);

  // Resize handling
  useEffect(() => {
    let animationFrame = 0;
    const measure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        if (!mainAreaRef.current) return;
        const width = Math.round(mainAreaRef.current.clientWidth);
        const height = Math.round(mainAreaRef.current.clientHeight);
        if (width > 0 && height > 0) {
          setContainerSize((previous) => (
            Math.abs(previous.width - width) < 2 && Math.abs(previous.height - height) < 2
              ? previous
              : { width, height }
          ));
        }
      });
    };

    // Initial measure with fallback to viewport if ref not ready
    if (mainAreaRef.current) {
      measure();
    } else {
      // Use window size as immediate fallback to avoid total white screen
      const winWidth = window.innerWidth;
      const winHeight = window.innerHeight - 56;
      setContainerSize({ 
        width: winWidth, 
        height: winHeight 
      });
    }

    const observer = new ResizeObserver(measure);
    if (mainAreaRef.current) {
      observer.observe(mainAreaRef.current);
    }

    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Calculate sizes
  const dimensions = useMemo(() => {
    if (!containerSize.width || !containerSize.height || !pdfPageSize.width) return null;

    const pdfWidth = pdfPageSize.width;
    const pdfHeight = pdfPageSize.height;
    
    // Use absolute full container for maximum scale with minimal padding.
    // Mobile uses a single-page layout so the PDF occupies the full available width.
    const safePadding = isMobile ? 10 : 20;
    const safeWidth = Math.max(containerSize.width - (safePadding * 2), 1);
    const safeHeight = Math.max(containerSize.height - (safePadding * 2), 1);

    const pageRatio = pdfWidth / pdfHeight;
    // A one-page PDF is a document, not a book spread. Keeping it out of
    // PageFlip prevents an empty companion page and gives zoom the full area.
    const isDoublePage = !isMobile && numPages > 1;
    const bookRatio = isDoublePage ? pageRatio * 2 : pageRatio;
    const containerRatio = safeWidth / safeHeight;

    let bookWidth;
    let bookHeight;

    if (containerRatio > bookRatio) {
      bookHeight = safeHeight;
      bookWidth = bookHeight * bookRatio;
    } else {
      bookWidth = safeWidth;
      bookHeight = bookWidth / bookRatio;
    }

    // Ensure we don't exceed container
    if (bookWidth > safeWidth) {
      bookWidth = safeWidth;
      bookHeight = bookWidth / bookRatio;
    }
    if (bookHeight > safeHeight) {
      bookHeight = safeHeight;
      bookWidth = bookHeight * bookRatio;
    }

    const pageWidth = isDoublePage ? bookWidth / 2 : bookWidth;
    const pageHeight = bookHeight;

    return {
      pageWidth: Math.floor(pageWidth),
      pageHeight: Math.floor(pageHeight),
      bookWidth: Math.floor(bookWidth),
      bookHeight: Math.floor(bookHeight),
      isDoublePage,
    };
  }, [containerSize, pdfPageSize, isMobile, numPages]);

  // Ensure ready strategy
  useEffect(() => {
    if (pdf && dimensions && dimensions.pageWidth > 0) {
      // Small timeout to allow container to stabilize in DOM
      const timer = setTimeout(() => {
        setReadyToRender(true);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [pdf, dimensions]);

  // Handle initial page and search from props
  useEffect(() => {
    if (!readyToRender || !pdf) return;
    const targetPage = Math.min(Math.max(Math.trunc(initialPage || 1), 1), pdf.numPages);
    const targetSearch = String(initialSearch || '').trim();
    const targetKey = `${documentId}:${docCacheKey}:${targetPage}:${targetSearch}`;
    if (initialTargetRef.current === targetKey) return;

    // Mark the destination only when the scheduled work actually starts. This
    // keeps React Strict Mode cleanup from consuming the deep link prematurely.
    const navigationTimer = window.setTimeout(() => {
      initialTargetRef.current = targetKey;
      goToPage(targetPage);
    }, 180);
    const searchTimer = targetSearch
      ? window.setTimeout(() => {
          setSearchQuery(targetSearch);
          void performSearch(targetSearch, targetPage);
          setSearchOpen(true);
        }, 380)
      : null;

    return () => {
      window.clearTimeout(navigationTimer);
      if (searchTimer !== null) window.clearTimeout(searchTimer);
    };
  }, [readyToRender, pdf, documentId, docCacheKey, initialPage, initialSearch]);


  const hasNoText = useMemo(() => {
    if (fullText.length === 0) return false;
    return fullText.every(item => item.text.trim().length === 0);
  }, [fullText]);

  // Index Generation Utilities
  const normalizeText = (value: string) => {
    return value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const isPageNumber = (text: string) => /^\d{1,3}$|^(p|pag|pagina)\.?\s?\d{1,3}$/i.test(text.trim());
  const isPrice = (text: string) => /[$\u20ac\u00a3]\s?\d+([.,]\d{2})?|\d+([.,]\d{2})?\s?[$\u20ac\u00a3]/.test(text.trim());
  const isUrl = (text: string) => /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/.test(text.trim());
  const isEmail = (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
  const isPhone = (text: string) => /(\+?\d{1,4}[\s-])?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/.test(text.trim());

  const looksLikeTitle = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === trimmed.toUpperCase() && trimmed.length > 3) return true;
    // Check for Title Case
    const words = trimmed.split(' ');
    if (words.length > 0 && words.every(w => w.length > 0 && w[0] === w[0].toUpperCase())) return true;
    return false;
  };

  const scoreHeadingCandidate = (candidate: any, pageStats: any) => {
    let score = 0;
    if (candidate.fontSize >= pageStats.avgFontSize * 1.5) score += 4;
    if (candidate.fontSize >= pageStats.avgFontSize * 1.25) score += 2;
    if (candidate.y / pageStats.height <= 0.25) score += 3; // Top of page
    if (looksLikeTitle(candidate.text)) score += 2;
    if (candidate.text.length <= 35) score += 1;
    if (candidate.text.length > 70) score -= 4;
    if (isPageNumber(candidate.text)) score -= 5;
    if (isPrice(candidate.text)) score -= 3;
    if (isUrl(candidate.text) || isEmail(candidate.text) || isPhone(candidate.text)) score -= 5;
    return score;
  };

  const buildAutoIndexFromPdf = useCallback(async (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
    setIndexStatus('loading');
    try {
      const result = await buildIndexFromPdfDocument(pdfDoc, {
        enableOcr: true,
        maxOcrPages: 8,
      });

      if (result.items.length === 0 && result.fullTextLength < 50 && !result.usedOcr) {
        setIndexStatus('no-text');
        return;
      }

      if (result.items.length === 0) {
        setIndexStatus('empty');
      } else {
        setIndexItems(result.items);
        setIndexSource(result.source);
        setIndexStatus('ready');
      }
    } catch (err) {
      console.error('Index generation error:', err);
      setIndexStatus('error');
    }
  }, []);

  // Search logic
  const performSearch = useCallback(async (query: string, preferredPage?: number) => {
    if (!pdf || query.trim().length < 2) {
      setSearchResults([]);
      setActiveMatchIndex(-1);
      return [];
    }

    setIsSearching(true);
    const results: SearchMatch[] = [];
    const normalizeSearchText = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const vocabulary = buildCatalogVocabulary([
      { text: title, weight: 20 },
      { text: currentDoc?.description || '', weight: 6 },
      { text: currentDoc?.category || '', weight: 12 },
      { text: (currentDoc?.tags || []).join(' '), weight: 12 },
      ...fullText.map((item) => ({ text: item.text, weight: 2 })),
    ]);
    const rawNormalizedQuery = normalizeSearchText(query).trim();
    const resolution = resolveCatalogQueryTokens(rawNormalizedQuery.split(/\s+/), vocabulary);
    const resolvedSearch = applyCatalogSpellingCorrections(query, resolution.corrections);
    const normalizedQuery = normalizeSearchText(resolvedSearch).trim();
    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const findSearchMatch = (text: string) => {
      const exact = text.indexOf(normalizedQuery);
      if (exact >= 0) return exact;
      const textWords = text.match(/[a-z0-9]+/g) || [];
      const tokenIndexes = queryTokens.map((token) => {
        const tokenIndex = text.indexOf(token);
        if (tokenIndex >= 0) return tokenIndex;
        if (token.length < 5) return -1;
        const closeWord = textWords.find((word) => (
          (Math.abs(word.length - token.length) <= 1 && catalogTypoDistance(token, word) <= 1) ||
          (token.endsWith('es') && word === token.slice(0, -2)) ||
          (word.endsWith('es') && token === word.slice(0, -2)) ||
          (token.endsWith('s') && word === token.slice(0, -1)) ||
          (word.endsWith('s') && token === word.slice(0, -1))
        ));
        return closeWord ? text.indexOf(closeWord) : -1;
      });
      if (queryTokens.length > 0 && tokenIndexes.every((index) => index >= 0)) {
        return Math.min(...tokenIndexes);
      }
      return -1;
    };
    if (resolution.corrections.length > 0 && resolvedSearch !== query) {
      setSearchQuery(resolvedSearch);
    }
    const createSearchSnippet = (text: string) => {
      const normalizedText = normalizeSearchText(text);
      const matchIndex = findSearchMatch(normalizedText);
      if (matchIndex === -1) return text.slice(0, 180).trim();
      const start = Math.max(0, matchIndex - 70);
      const end = Math.min(text.length, matchIndex + query.length + 90);
      return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
    };

    // If we have fullText, use it for instant matching instead of re-parsing PDF
    if (fullText.length > 0) {
      console.log('[Flipbook] Performing instant search via fullText cache');
      const matchesByPage = new Map<number, { page: number, text: string }[]>();
      
      for (const item of fullText) {
        const normalizedItemText = item.text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (findSearchMatch(normalizedItemText) >= 0) {
            if (!matchesByPage.has(item.page)) matchesByPage.set(item.page, []);
            matchesByPage.get(item.page)!.push(item);
        }
      }

      for (const [pageNumber, pageMatches] of matchesByPage) {
            try {
                const page = await pdf.getPage(pageNumber);
                const textContent = await page.getTextContent();
                const viewport = page.getViewport({ scale: 1 });
                const resultCountBeforePage = results.length;
                
                textContent.items.forEach((txtItem: any) => {
                    if (!txtItem || typeof txtItem.str !== 'string') return;
                    const normalizedTxtItem = normalizeSearchText(txtItem.str);
                    if (normalizedTxtItem.includes(normalizedQuery)) {
                        const transform = txtItem.transform;
                        const [x, y, w, h] = [transform[4], transform[5], txtItem.width, txtItem.height];
                        
                        const rect: HighlightRect = {
                          left: (x / viewport.width) * 100,
                          top: ((viewport.height - y - h) / viewport.height) * 100,
                          width: (w / viewport.width) * 100,
                          height: (h / viewport.height) * 100
                        };

                        results.push({
                          id: `match-${pageNumber}-${Math.random().toString(36).substring(2, 9)}`,
                          pageNumber: pageNumber,
                          text: txtItem.str,
                          rects: [rect]
                        });
                    }
                });

                if (results.length === resultCountBeforePage) {
                  const pageText = pageMatches.map(item => item.text).join(' ');
                  results.push({
                    id: `match-${pageNumber}-page-${Math.random().toString(36).substring(2, 9)}`,
                    pageNumber,
                    text: createSearchSnippet(pageText),
                    rects: []
                  });
                }
            } catch (e) {
                console.warn(`Search match error on page ${pageNumber}:`, e);
            }
      }
    } else {
        // Fallback to slow linear search
        for (let i = 1; i <= pdf.numPages; i++) {
          try {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1 });
            if (textContent && Array.isArray(textContent.items)) {
              const resultCountBeforePage = results.length;
              const pageText = textContent.items.map((item: any) => item?.str || '').join(' ');

              textContent.items.forEach((item: any) => {
                if (!item || typeof item.str !== 'string') return;
                const normalizedItemText = normalizeSearchText(item.str);

                if (normalizedItemText.includes(normalizedQuery)) {
                  // ... inside loop
                  const transform = item.transform;
                  const [x, y, w, h] = [transform[4], transform[5], item.width, item.height];
                  
                  const rect: HighlightRect = {
                    left: (x / viewport.width) * 100,
                    top: ((viewport.height - y - h) / viewport.height) * 100,
                    width: (w / viewport.width) * 100,
                    height: (h / viewport.height) * 100
                  };

                  results.push({
                    id: `match-${i}-${Math.random().toString(36).substring(2, 9)}`,
                    pageNumber: i,
                    text: item.str,
                    rects: [rect]
                  });
                }
              });

              if (results.length === resultCountBeforePage && findSearchMatch(normalizeSearchText(pageText)) >= 0) {
                results.push({
                  id: `match-${i}-page-${Math.random().toString(36).substring(2, 9)}`,
                  pageNumber: i,
                  text: createSearchSnippet(pageText),
                  rects: []
                });
              }
            }
          } catch (e) {
            console.warn(`Search error on page ${i}:`, e);
          }
        }
    }

    // Some image-heavy PDFs expose useful headings/bookmarks even when their
    // page text layer is incomplete. Use that already persisted index as a
    // verified fallback so the search can still jump to the correct page.
    if (results.length === 0 && indexItems.length > 0) {
      const pendingItems = [...indexItems];
      while (pendingItems.length > 0) {
        const item = pendingItems.shift();
        if (!item) continue;
        if (item.children?.length) pendingItems.push(...item.children);
        if (findSearchMatch(normalizeSearchText(item.title)) < 0) continue;
        results.push({
          id: `match-${item.pageNumber}-index-${item.id}`,
          pageNumber: item.pageNumber,
          text: item.title,
          rects: [],
        });
      }
    }

    setSearchResults(results);
    setIsSearching(false);
    setHighlightsVisible(results.length > 0);
    
    if (results.length > 0) {
      let targetIdx = -1;
      
      // 1. Try preferredPage if provided
      if (preferredPage) {
        targetIdx = results.findIndex(r => r.pageNumber === preferredPage);
      }
      
      // 2. Try current page from state
      if (targetIdx === -1) {
        const currentPageIndex = dimensions?.isDoublePage
          ? bookRef.current?.pageFlip?.()?.getCurrentPageIndex() || currentPage
          : currentPage;
        targetIdx = results.findIndex(r => r.pageNumber === currentPageIndex + 1);
      }
      
      const definitiveIdx = targetIdx !== -1 ? targetIdx : 0;
      setActiveMatchIndex(definitiveIdx);
      
      const targetPage = results[definitiveIdx].pageNumber;
      
      // Auto-zoom onto the first match
      goToPage(targetPage, true);
      setTimeout(() => {
        const rect = results[definitiveIdx].rects[0];
        if (rect) {
          setZoomOrigin({ 
            x: `${rect.left + rect.width / 2}%`, 
            y: `${rect.top + rect.height / 2}%` 
          });
          setZoom(SEARCH_FOCUS_ZOOM);
        }
      }, 300);

      return results;
    } else {
      setActiveMatchIndex(-1);
      if (hasNoText) {
        console.warn("Este PDF no tiene texto buscable.");
      } else {
        if (isMobile) {
          console.log("Sin resultados");
        }
      }
      return [];
    }
  }, [pdf, numPages, fullText, hasNoText, isMobile, currentPage, dimensions?.isDoublePage, title, currentDoc, indexItems]);

  // A deep-linked search can start a few milliseconds before the persisted
  // page index finishes loading. Retry once that verified index is available;
  // otherwise the panel could incorrectly remain on "No hay resultados".
  useEffect(() => {
    if (
      !readyToRender ||
      !pdf ||
      !String(initialSearch || '').trim() ||
      indexItems.length === 0 ||
      searchResults.length > 0
    ) return;
    const retryTimer = window.setTimeout(() => {
      void performSearch(String(initialSearch), initialPage);
    }, 0);
    return () => window.clearTimeout(retryTimer);
  }, [readyToRender, pdf, initialSearch, initialPage, indexItems, searchResults.length, performSearch]);

  const handleSearchResultClick = (index: number) => {
    const result = searchResults[index];
    if (!result) return;
    
    // 1. Go to page FIRST (with zoom reset skipped)
    goToPage(result.pageNumber, true);
    
    // 2. Then apply subtle zoom
    setActiveMatchIndex(index);
    setHighlightsVisible(true);
    
    setTimeout(() => {
      if (result.rects && result.rects.length > 0) {
        const rect = result.rects[0];
        setZoomOrigin({ 
          x: `${rect.left + rect.width / 2}%`, 
          y: `${rect.top + rect.height / 2}%` 
        });
        setZoom(SEARCH_FOCUS_ZOOM);
      }
    }, 100);
  };

  const clearSearch = () => {
    // If we have an active selection, keep only that one and stop showing others
    if (activeMatchIndex !== -1 && searchResults[activeMatchIndex]) {
      const activeMatch = searchResults[activeMatchIndex];
      setSearchResults([activeMatch]);
      setActiveMatchIndex(0);
      setHighlightsVisible(true);
      setSearchQuery(''); // Clear query but keep the one match
      
      // Close panels so user can "navigate normally" as requested
      setSearchOpen(false);
      setIsMobileSearchOpen(false);
      setIsSearchResultsSheetOpen(false);
    } else {
      setSearchQuery('');
      setSearchResults([]);
      setActiveMatchIndex(-1);
      setHighlightsVisible(false);
      resetZoom();
    }
  };

  const nextMatch = () => {
    if (searchResults.length === 0) return;
    const nextIdx = (activeMatchIndex + 1) % searchResults.length;
    handleSearchResultClick(nextIdx);
  };

  const prevMatch = () => {
    if (searchResults.length === 0) return;
    const prevIdx = (activeMatchIndex - 1 + searchResults.length) % searchResults.length;
    handleSearchResultClick(prevIdx);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim().length >= 2) {
      performSearch(searchQuery);
      setSearchOpen(true);
    }
  };

  const goToPage = (num: number, skipZoomReset = false) => {
    if (!Number.isFinite(num)) return;
    if (!skipZoomReset) resetZoom();

    const total = numPages || 1;
    const safePage = Math.min(Math.max(Math.trunc(num), 1), total);

    if (!dimensions?.isDoublePage) {
      setPageInput(safePage.toString());
      setCurrentPage(safePage - 1);
      return;
    }
    
    // With showCover=true, page 1 is alone and subsequent pages are spreads:
    // 2-3, 4-5, etc. Always target the left page of the requested spread.
    const flipIndex = safePage === 1
      ? 0
      : (safePage % 2 === 0 ? safePage - 1 : safePage - 2);

    // Updating ?page= after a successful turn feeds the same page back as
    // initialPage. Never start another animation/lock for that same spread.
    if (flipIndex === currentPage) {
      setPageInput((currentPage + 1).toString());
      return;
    }
    if (!beginNavigation()) return;
    setPageInput(safePage.toString());

    const sourceCenterPage = Math.min(Math.max(currentPage + 1, 1), total);
    const sourcePages = sourceCenterPage === 1
      ? [1]
      : [sourceCenterPage, Math.min(sourceCenterPage + 1, total)];
    const destinationPages = flipIndex === 0
      ? [1]
      : [flipIndex + 1, Math.min(flipIndex + 2, total)];
    setTurningPages(new Set([...sourcePages, ...destinationPages]));

    setRenderFocusPage(flipIndex);
    verifyPageWindow(flipIndex);

    const turnFlipbookToPage = () => {
      const pageFlipInstance = bookRef.current?.pageFlip?.();
      // Prefer the animated API. `turnToPage` changes the spread immediately,
      // which bypasses the flexible-paper curl rendered by PageFlip.
      if (pageFlipInstance && typeof pageFlipInstance.flip === 'function') {
        pageFlipInstance.flip(flipIndex, 'top');
        return true;
      } else if (pageFlipInstance && typeof pageFlipInstance.turnToPage === 'function') {
        pageFlipInstance.turnToPage(flipIndex);
        return true;
      }
      return false;
    };

    const startedAt = performance.now();

    const turnWhenReady = () => {
      verifyPageWindow(flipIndex);
      const root = mainAreaRef.current;
      const ready = !!root && destinationPages.every((pageNumber) => {
        const nodes = root.querySelectorAll(
          `[data-pdf-page="${pageNumber}"]`,
        ) as NodeListOf<QueuedPdfPageElement>;
        let pageReady = false;
        nodes.forEach((node) => {
          if (node.dataset.pdfRendered === 'true') pageReady = true;
        });
        return pageReady;
      });

      // The automatic recovery UI remains visible if a very complex page takes
      // longer than five seconds, but navigation can no longer get permanently
      // locked waiting for it.
      if (ready || performance.now() - startedAt >= 5000) {
        setPageInput((flipIndex + 1).toString());
        window.requestAnimationFrame(() => {
          if (!turnFlipbookToPage()) {
            setTurningPages(new Set());
            setRenderFocusPage(null);
            clearNavigationLock();
          }
        });
        return;
      }

      navigationRetryTimerRef.current = window.setTimeout(turnWhenReady, 100);
    };

    window.requestAnimationFrame(turnWhenReady);
  };

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value.replace(/\D/g, ''));
  };

  const handlePageInputBlur = () => {
    const val = Number.parseInt(pageInput, 10);
    if (Number.isFinite(val)) {
      goToPage(val);
    } else {
      setPageInput((currentPage + 1).toString());
    }
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setPageInput((currentPage + 1).toString());
      e.currentTarget.blur();
    }
  };

  // Sync page input with current page
  useEffect(() => {
    setPageInput((currentPage + 1).toString());
  }, [currentPage]);

  // Keep deep links reload-safe. The viewer used to change the visible page
  // without updating ?page=, so refreshing could unexpectedly jump back to
  // the page from which the catalog was first opened.
  useEffect(() => {
    if (!readyToRender || !pdf || !initialTargetRef.current || !onPageChange) return;
    const visiblePage = Math.min(Math.max(currentPage + 1, 1), pdf.numPages);
    if (lastReportedPageRef.current === visiblePage) return;
    lastReportedPageRef.current = visiblePage;
    onPageChange(visiblePage);
  }, [currentPage, readyToRender, pdf, onPageChange]);

  const downloadPdf = useCallback(async () => {
    const finalUrl = downloadUrl || url;
    if (!finalUrl) {
      console.error("No existe URL de descarga para este catálogo");
      return;
    }

    try {
      const response = await fetch(finalUrl);
      if (!response.ok) throw new Error("No se pudo descargar el PDF");
      
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = blobUrl;
      const fileName = title.trim()
        ? `${title.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_')}.pdf`
        : 'catalogo.pdf';
        
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (error) {
      console.warn("Error al descargar via fetch, intentando apertura directa:", error);
      window.open(finalUrl, '_blank', 'noopener,noreferrer');
    }
  }, [url, downloadUrl, title]);


  const pageIndicatorStr = useMemo(() => {
    if (!numPages) return '0 / 0';
    if (!dimensions?.isDoublePage) {
      return `${Math.min(currentPage + 1, numPages)} / ${numPages}`;
    }
    if (currentPage === 0) return `1 / ${numPages}`;
    const next = currentPage + 1;
    if (next >= numPages) return `${numPages} / ${numPages}`;
    return `${currentPage + 1}-${next + 1} / ${numPages}`;
  }, [currentPage, numPages, dimensions?.isDoublePage]);

  const isAtLastPage = useMemo(() => {
    if (!dimensions?.isDoublePage) return currentPage >= numPages - 1;
    const lastSpreadIndex = numPages <= 1
      ? 0
      : (numPages % 2 === 0 ? numPages - 1 : numPages - 2);
    return currentPage >= lastSpreadIndex;
  }, [currentPage, dimensions?.isDoublePage, numPages]);

  const zoomIn = () => setZoom(prev => Math.min(prev + 0.25, 2.5));
  const zoomOut = () => setZoom(prev => Math.max(prev - 0.25, 1));
  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setZoomOrigin({ x: '50%', y: '50%' });
  };

  function goToPreviousPage(skipZoomReset = false) {
    if (!skipZoomReset) resetZoom();
    if (dimensions?.isDoublePage) {
      const targetPage = currentPage <= 1 ? 1 : currentPage - 1;
      goToPage(targetPage, true);
      return;
    }

    goToPage(Math.max(1, currentPage), true);
  }

  function goToNextPage(skipZoomReset = false) {
    if (!skipZoomReset) resetZoom();
    if (dimensions?.isDoublePage) {
      const lastSpreadIndex = numPages <= 1
        ? 0
        : (numPages % 2 === 0 ? numPages - 1 : numPages - 2);
      if (currentPage >= lastSpreadIndex) return;
      const targetPage = currentPage === 0 ? 2 : currentPage + 3;
      goToPage(Math.min(numPages || 1, targetPage), true);
      return;
    }

    goToPage(Math.min(numPages || 1, currentPage + 2), true);
  }

  const activeIndexItem = useMemo(() => {
    if (!indexItems.length) return null;
    const current = currentPage + 1;
    let found = indexItems[0];
    for (const item of indexItems) {
      if (item.pageNumber <= current) {
        found = item;
      } else {
        break;
      }
    }
    return found;
  }, [indexItems, currentPage]);

  // Helper to build a tree from a flat list based on 'level'
  const buildTocTree = useCallback((items: PdfIndexItem[]): PdfIndexItem[] => {
    const root: PdfIndexItem[] = [];
    const stack: PdfIndexItem[] = [];

    items.forEach(item => {
      const node = { ...item, children: [] as PdfIndexItem[] };
      
      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(node);
      } else {
        if (!stack[stack.length - 1].children) stack[stack.length - 1].children = [];
        stack[stack.length - 1].children!.push(node);
      }
      
      stack.push(node);
    });

    return root;
  }, []);

  const tocTree = useMemo(() => buildTocTree(indexItems), [indexItems, buildTocTree]);

  const toggleIndexItem = (id: string, event?: React.MouseEvent) => {
    if (event) event.stopPropagation();
    setExpandedIndexItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Automatically expand parents of the active item
  useEffect(() => {
    if (!activeIndexItem) return;
    
    // Find all parents of the active item to ensure they are expanded
    const expandParents = (itemId: string) => {
      const idx = indexItems.findIndex(n => n.id === itemId);
      if (idx === -1) return;
      
      let currentLevel = indexItems[idx].level;
      const parentsToExpand: string[] = [];
      
      for (let i = idx - 1; i >= 0; i--) {
        if (indexItems[i].level < currentLevel) {
          parentsToExpand.push(indexItems[i].id);
          currentLevel = indexItems[i].level;
          if (currentLevel === 0) break;
        }
      }
      
      if (parentsToExpand.length > 0) {
        setExpandedIndexItems(prev => {
          let needsUpdate = false;
          const next = new Set(prev);
          parentsToExpand.forEach(p => {
            if (!next.has(p)) {
              next.add(p);
              needsUpdate = true;
            }
          });
          return needsUpdate ? next : prev;
        });
      }
    };
    
    expandParents(activeIndexItem.id);
  }, [activeIndexItem, indexItems]);

  const verifyPageWindow = useCallback((pageIndex: number) => {
    if (numPages === 0) return;

    const centerPage = Math.min(Math.max(pageIndex + 1, 1), numPages);
    const visiblePages = dimensions?.isDoublePage && centerPage > 1
      ? [centerPage, Math.min(centerPage + 1, numPages)]
      : [centerPage];
    setPrefetchPages(new Set(visiblePages));
  }, [dimensions?.isDoublePage, numPages]);

  const handlePageRendered = useCallback((pageNumber: number) => {
    setRenderedPages((previous) => {
      if (previous.has(pageNumber)) return previous;
      const next = new Set(previous);
      next.add(pageNumber);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!readyToRender || !dimensions || numPages === 0) return;
    const centerPage = Math.min(
      Math.max((renderFocusPage ?? currentPage) + 1, 1),
      numPages,
    );
    const visiblePages = dimensions.isDoublePage && centerPage > 1
      ? [centerPage, Math.min(centerPage + 1, numPages)]
      : [centerPage];
    if (!visiblePages.every((pageNumber) => renderedPages.has(pageNumber))) return;

    const timer = window.setTimeout(() => {
      const firstPage = Math.max(1, centerPage - 2);
      const lastPage = Math.min(numPages, centerPage + 3);
      const next = new Set(visiblePages);
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
        next.add(pageNumber);
      }
      setPrefetchPages(next);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    currentPage,
    dimensions,
    numPages,
    readyToRender,
    renderedPages,
    renderFocusPage,
  ]);

  useEffect(() => {
    if (readyToRender) verifyPageWindow(currentPage);
  }, [currentPage, readyToRender, verifyPageWindow]);

  const renderPdfPage = (pageNumber: number, key: string) => {
    if (!dimensions) return null;

    const centerPage = (renderFocusPage ?? currentPage) + 1;
    const visiblePages = dimensions.isDoublePage && centerPage > 1
      ? [centerPage, Math.min(centerPage + 1, numPages)]
      : [centerPage];
    const priority = visiblePages.includes(pageNumber);
    const eager = priority || prefetchPages.has(pageNumber) || turningPages.has(pageNumber);

    const pageHighlights = highlightsVisible ? (searchResults || [])
      .filter(res => res && res.pageNumber === pageNumber)
      .flatMap(res => res.rects.map(r => ({
        rect: r,
        isActive: activeMatchIndex !== -1 && searchResults[activeMatchIndex] === res
      }))) : [];

    return (
      <QueuedPdfPage
        key={key}
        number={pageNumber}
        pdf={pdf}
        width={dimensions.pageWidth}
        height={dimensions.pageHeight}
        zoom={zoom}
        eager={eager}
        priority={priority}
        docUrl={docCacheKey}
        onRendered={handlePageRendered}
        highlights={pageHighlights}
        isActiveMatchPage={activeMatchIndex !== -1 && searchResults[activeMatchIndex] && searchResults[activeMatchIndex].pageNumber === pageNumber}
      />
    );
  };

  const stableFlipbookPages = useMemo(() => {
    if (!dimensions || !pdf || numPages < 1) return [];
    return Array.from({ length: numPages }, (_, index) => (
      <FlipbookPage
        key={`page-${index}`}
        number={index + 1}
        pdf={pdf}
        width={dimensions.pageWidth}
        height={dimensions.pageHeight}
        docUrl={docCacheKey}
        onRendered={handlePageRendered}
      />
    ));
  }, [numPages, pdf, dimensions?.pageWidth, dimensions?.pageHeight, docCacheKey, handlePageRendered]);

  return (
    <>
      <div className="pdf-viewer-shell">
        <div className={cn(
          "pdf-reader-page", 
          !isIndexOpen && "is-sidebar-collapsed",
          isThumbnailPanelOpen && "has-thumbnail-sidebar"
        )}>
        {/* 1. PANEL IZQUIERDO DE ÍNDICE / CONTENIDO */}
        <aside className="pdf-content-sidebar">
          <div className="pdf-content-header">
            <span>CONTENIDO</span>
            <button onClick={() => setIsIndexOpen(false)} aria-label="Cerrar índice">×</button>
          </div>

        <nav className="pdf-content-list">
          {indexStatus === 'loading' ? (
            <div className="py-20 flex flex-col items-center gap-4 text-center px-6">
              <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
              <p className="text-xs text-gray-400 font-medium">Analizando secciones...</p>
            </div>
          ) : indexStatus === 'ready' ? (
            <div className="flex flex-col gap-0.5">
              {(() => {
                const renderItems = (items: PdfIndexItem[], level: number = 0) => {
                  return items.map((item) => {
                    const hasChildren = item.children && item.children.length > 0;
                    const isExpanded = expandedIndexItems.has(item.id);
                    const isActive = activeIndexItem?.id === item.id;

                    return (
                      <div key={item.id} className="flex flex-col">
                        <div className="relative group">
                          <button 
                            onClick={() => {
                              goToPage(item.pageNumber);
                              if (isMobile) setIsIndexOpen(false);
                            }}
                            className={cn(
                              "pdf-content-item items-center py-2.5 transition-colors w-full",
                              isActive && "is-active",
                              level === 0 ? "font-bold" : "font-medium"
                            )}
                            style={{ paddingLeft: `${22 + level * 16}px` }}
                          >
                            <span className={cn(
                              "flex-1 text-sm overflow-hidden text-ellipsis whitespace-nowrap",
                              isActive ? "text-white" : "text-gray-900/80"
                            )}>
                              {item.title}
                            </span>
                            <strong className={cn(
                              "text-[10px] tabular-nums",
                              isActive ? "text-white/80" : "text-gray-400"
                            )}>
                              {item.pageNumber.toString().padStart(2, '0')}
                            </strong>
                          </button>
                          
                          {hasChildren && (
                            <button
                              onClick={(e) => toggleIndexItem(item.id, e)}
                              className={cn(
                                "absolute left-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md transition-colors z-10",
                                isActive ? "text-white/40" : "text-gray-400 hover:bg-gray-100",
                                isExpanded && "rotate-0"
                              )}
                              aria-label={isExpanded ? "Contraer" : "Expandir"}
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>

                        {hasChildren && isExpanded && (
                          <div className="flex flex-col">
                            {renderItems(item.children!, level + 1)}
                          </div>
                        )}
                      </div>
                    );
                  });
                };
                return renderItems(tocTree);
              })()}
            </div>
          ) : (
            <div className="py-20 px-8 text-center text-gray-400">
              <p className="text-xs">No hay contenido disponible</p>
            </div>
          )}
        </nav>

        <button onClick={downloadPdf} className="pdf-download-card group">
          <Download className="transition-transform group-hover:translate-y-0.5" />
          <span>
            <strong>Descargar catálogo</strong>
            <small>PDF {currentDoc?.fileSize ? formatFileSize(currentDoc.fileSize) : "--- MB"}</small>
          </span>
        </button>
      </aside>

      {/* ÁREA PRINCIPAL DEL VISOR */}
      <main className="pdf-reader-main">
        <div className="pdf-viewer-container">
          {/* 2. TOOLBAR SUPERIOR */}
          <header className="pdf-reader-toolbar">
            <div className="pdf-toolbar-left">
              {!isIndexOpen && (
                <button 
                  onClick={() => setIsIndexOpen(true)}
                  className="hover:bg-gray-100 transition-colors"
                  title="Abrir índice"
                >
                  <ListIcon className="w-5 h-5" />
                </button>
              )}
              <span className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-2">Visor de Catálogo</span>
            </div>

            <nav className="pdf-toolbar-pagination" aria-label="Navegación por páginas">
              <button
                type="button"
                onClick={() => goToPreviousPage()}
                aria-label="Página anterior"
                title="Página anterior"
                disabled={!numPages || currentPage === 0}
              >
                <ChevronLeft aria-hidden="true" />
              </button>

              <div className="pdf-toolbar-page-counter">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pageInput}
                  onChange={handlePageInputChange}
                  onBlur={handlePageInputBlur}
                  onKeyDown={handlePageInputKeyDown}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label={`Ir a una página entre 1 y ${numPages || 1}`}
                  title="Escribe una página y presiona Enter"
                  disabled={!numPages}
                />
                <span aria-hidden="true">/</span>
                <strong aria-label={`${numPages} páginas en total`}>{numPages || 0}</strong>
              </div>

              <button
                type="button"
                onClick={() => goToNextPage()}
                aria-label="Página siguiente"
                title="Página siguiente"
                disabled={!numPages || isAtLastPage}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </nav>

            <div className="pdf-toolbar-actions">
              <button
                onClick={() => navigate('/buscar')}
                className="pdf-toolbar-action--library"
                title="Buscar en toda la biblioteca"
                aria-label="Buscar en toda la biblioteca"
              >
                <Library className="w-5 h-5" />
              </button>
              <button
                onClick={() => setSearchOpen(!searchOpen)}
                className={cn("pdf-toolbar-action--search", searchOpen && "bg-gray-100")}
                title="Buscar dentro de este PDF"
                aria-label="Buscar dentro de este PDF"
              >
                <SearchIcon className="w-5 h-5" />
              </button>
              {zoom > 1 && (
                <button 
                  onClick={resetZoom} 
                  title="Restablecer" 
                  aria-label="Restablecer zoom"
                  className="pdf-toolbar-action--reset bg-gray-100 text-blue-600 rounded-full"
                >
                  <Minimize2 className="w-5 h-5" />
                </button>
              )}
              <button
                onClick={zoomOut}
                className="pdf-toolbar-action--zoom-out"
                title="Alejar"
                aria-label="Alejar"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <button
                onClick={zoomIn}
                className="pdf-toolbar-action--zoom-in"
                title="Acercar"
                aria-label="Acercar"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              <button
                onClick={() => mainAreaRef.current?.requestFullscreen()}
                className="pdf-toolbar-action--fullscreen"
                title="Pantalla completa"
                aria-label="Pantalla completa"
              >
                <Maximize2 className="w-5 h-5" />
              </button>
              <button 
                className={cn("pdf-toolbar-action--thumbnails", isThumbnailPanelOpen && "is-active")}
                title="Miniaturas"
                aria-label="Abrir miniaturas"
                onClick={() => setIsThumbnailPanelOpen(!isThumbnailPanelOpen)}
              >
                <LayoutGrid className="w-5 h-5" />
              </button>
            </div>
          </header>

          {/* 3. ÁREA CENTRAL DEL LIBRO */}
          <section 
            className="pdf-stage" 
            ref={mainAreaRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ touchAction: 'none' }}
          >
            <div className="pdf-book-area">
              {/* BOTONES LATERALES */}
              <button 
                className="pdf-side-nav pdf-side-nav--prev"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  goToPreviousPage();
                }}
                aria-label="Página anterior"
                disabled={currentPage === 0}
                style={{ opacity: currentPage === 0 ? 0 : 1, pointerEvents: currentPage === 0 ? 'none' : 'auto' }}
              >
                <ChevronLeft className="w-6 h-6" />
              </button>

              <div className="pdf-book-wrapper">
                 {/* Loading & Error Overlays */}
                 {(loading || !readyToRender) && !error && (
                    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl">
                      <div className="w-10 h-10 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                      <p className="mt-4 text-xs font-bold text-gray-800">
                        {loadProgress > 0 ? `${loadProgress}%` : 'Preparando'} el catálogo…
                      </p>
                      <div className="mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-gray-200">
                        <div
                          className={cn(
                            "h-full rounded-full bg-blue-600 transition-all duration-300",
                            loadProgress === 0 && "w-1/3 animate-pulse"
                          )}
                          style={loadProgress > 0 ? { width: `${loadProgress}%` } : undefined}
                        />
                      </div>
                      {loadAttempt > 1 ? (
                        <p className="mt-3 text-[10px] font-semibold text-gray-500">
                          Reintento automático {loadAttempt} de {PDF_DOCUMENT_ATTEMPTS}
                        </p>
                      ) : null}
                    </div>
                  )}

                  {error && (
                    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white p-8 text-center rounded-2xl border border-red-100">
                      <div className="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-red-200 border-t-red-500" />
                      <p className="text-sm font-medium text-gray-900">{error}</p>
                      <p className="mt-4 text-xs font-semibold text-red-500">
                        Recuperación automática del catálogo en curso…
                      </p>
                    </div>
                  )}

                {dimensions && readyToRender && (
                  <div 
                    className={cn(
                      "pdf-book-spread",
                      zoom > 1 && "is-zoomed",
                      !dimensions.isDoublePage && "is-single-page",
                      numPages === 1 && "is-document-single-page"
                    )}
                    style={{ 
                      width: dimensions.bookWidth, 
                      height: dimensions.bookHeight,
                      transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                      transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
                      transition: isPanning ? 'none' : 'transform 200ms cubic-bezier(0.2, 0, 0.2, 1)'
                    }}
                  >
                    {dimensions.isDoublePage ? (
                      <FlipbookPageContext.Provider value={{
                        currentPage,
                        renderFocusPage,
                        prefetchPages,
                        turningPages,
                        numPages,
                        zoom,
                        highlightsVisible,
                        searchResults,
                        activeMatchIndex,
                      }}>
                      <HTMLFlipBook
                        key={`flipbook-${pdf?.fingerprints?.[0] || 'ready'}-${dimensions.pageWidth}x${dimensions.pageHeight}`}
                        ref={bookRef}
                        width={dimensions.pageWidth}
                        height={dimensions.pageHeight}
                        size="fixed"
                        minWidth={dimensions.pageWidth}
                        maxWidth={dimensions.pageWidth}
                        minHeight={dimensions.pageHeight}
                        maxHeight={dimensions.pageHeight}
                        usePortrait={false}
                        renderOnlyPageLengthChange={true}
                        startZIndex={0}
                        swipeDistance={30}
                        showPageCorners={true}
                        disableFlipByClick={false}
                        startPage={currentPage}
                        /* Let our own gesture layer fully control input: this
                           stops react-pageflip from flipping on its own click/
                           drag, which was stealing the first tap of a double-tap
                           (causing accidental page turns instead of zoom). Flips
                           are still animated via the pageFlip() API. */
                        useMouseEvents={false}
                        clickEventForward={false}
                        onFlip={(e: any) => {
                          const pageIndex = Number(e.data);
                          clearNavigationLock();
                          if (!Number.isFinite(pageIndex)) return;
                          setCurrentPage(pageIndex);
                          setRenderFocusPage(null);
                          setPageInput((pageIndex + 1).toString());
                          verifyPageWindow(pageIndex);
                          if (zoom > 1.01) resetZoom();
                        }}
                        onChangeState={(e: any) => {
                          if (e.data !== 'flipping') {
                            setTurningPages(new Set());
                            clearNavigationLock();
                          }
                        }}
                        showCover={true}
                        drawShadow={true}
                        maxShadowOpacity={0.42}
                        mobileScrollSupport={false}
                        flippingTime={1050}
                        className="pdf-flipbook"
                        style={{
                          margin: '0 auto',
                          width: dimensions.bookWidth,
                          height: dimensions.bookHeight,
                        }}
                        autoSize={true}
                      >
                        {stableFlipbookPages}
                      </HTMLFlipBook>
                      </FlipbookPageContext.Provider>
                    ) : (
                      <div className="pdf-mobile-single-page">
                        {renderPdfPage(
                          Math.min(Math.max(currentPage + 1, 1), numPages || 1),
                          `mobile-page-${currentPage}`
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

                <button 
                  className="pdf-side-nav pdf-side-nav--next"
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    goToNextPage();
                  }}
                  aria-label="Página siguiente"
                  disabled={isAtLastPage}
                  style={{ opacity: isAtLastPage ? 0 : 1, pointerEvents: isAtLastPage ? 'none' : 'auto' }}
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
            </div>
          </section>

          {/* 4. BARRA INFERIOR DE PROGRESO */}
          <footer className="pdf-progress-toolbar">
            <span className="tabular-nums">
              {pageIndicatorStr}
            </span>
            <input 
              type="range" 
              min="1" 
              max={numPages} 
              value={Math.min(Math.max(Number.parseInt(pageInput, 10) || 1, 1), numPages || 1)}
              onChange={(e) => setPageInput(e.target.value)}
              onPointerUp={handlePageInputBlur}
              onKeyUp={handlePageInputBlur}
              onBlur={handlePageInputBlur}
              className="pdf-progress-slider"
            />
            <button 
              className={cn(isThumbnailPanelOpen && "is-active")}
              title="Miniaturas" 
              onClick={() => setIsThumbnailPanelOpen(!isThumbnailPanelOpen)}
            >
              <LayoutGrid className="w-5 h-5" />
            </button>
          </footer>
        </div>
      </main>

        {/* PANEL DERECHO DE MINIATURAS (Sibling of main) */}
        <AnimatePresence>
          {isThumbnailPanelOpen && (
            <motion.aside 
              initial={{ x: 300 }}
              animate={{ x: 0 }}
              exit={{ x: 300 }}
              className="pdf-thumbnail-sidebar"
            >
              <div className="pdf-thumbnail-header">
                <span>MINIATURAS</span>
                <button onClick={() => setIsThumbnailPanelOpen(false)} aria-label="Cerrar miniaturas">×</button>
              </div>

              <div className="pdf-thumbnail-list">
                {Array.from({ length: numPages }).map((_, i) => {
                  const pageNumber = i + 1;
                  const isActive = currentPage === i || (dimensions?.isDoublePage && currentPage + 1 === i);
                  
                  return (
                    <button
                      key={pageNumber}
                      onClick={() => {
                        goToPage(pageNumber);
                        if (isMobile) setIsThumbnailPanelOpen(false);
                      }}
                      className={cn(
                        "pdf-thumbnail-item",
                        isActive && "is-active"
                      )}
                    >
                      <div className="pdf-thumbnail-canvas-wrapper">
                        <LazyPdfPageThumbnail 
                          pdf={pdf} 
                          pageNumber={pageNumber} 
                          cache={thumbnailCache}
                          onThumbnailRendered={(p, data) => {
                            setThumbnailCache(prev => {
                              if (prev.has(p)) return prev;
                              const next = new Map(prev);
                              next.set(p, data);
                              while (next.size > 24) {
                                const oldest = next.keys().next().value as number | undefined;
                                if (oldest === undefined) break;
                                next.delete(oldest);
                              }
                              return next;
                            });
                          }}
                        />
                      </div>
                      <span>Pág. {pageNumber}</span>
                    </button>
                  );
                })}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* BÚSQUEDA PANEL (FLOTANTE DENTRO DE PAGE) */}
        <AnimatePresence>
          {searchOpen && (
            <motion.aside 
              initial={{ x: 300 }}
              animate={{ x: 0 }}
              exit={{ x: 300 }}
              className="absolute right-0 top-0 bottom-0 w-80 bg-white shadow-2xl z-[60] border-l border-gray-100 flex flex-col"
            >
              <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-sm tracking-tight text-gray-900">BÚSQUEDA</h3>
                  {searchResults.length > 0 && (
                    <button 
                      onClick={clearSearch}
                      className="text-[10px] text-blue-600 font-bold hover:underline"
                    >
                      LIMPIAR
                    </button>
                  )}
                </div>
                <button onClick={() => setSearchOpen(false)}><X className="w-5 h-5 text-gray-400" /></button>
              </div>
              
              <div className="px-5 py-4 border-b border-gray-100 bg-white">
                <form onSubmit={handleSearch} className="relative flex items-center group">
                  <div className="flex-1 bg-gray-50 rounded-xl flex items-center px-4 py-2.5 transition-all border border-gray-100 focus-within:border-gray-300 focus-within:bg-white group-hover:bg-white">
                    <button
                      type="submit"
                      className="text-gray-400 hover:text-gray-900 transition-colors mr-3 flex-shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={searchQuery.trim().length < 2 || isSearching}
                      aria-label="Buscar en este catalogo"
                      title="Buscar"
                    >
                      <SearchIcon className="w-4 h-4" />
                    </button>
                    <input 
                      autoFocus
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Buscar en este catálogo..."
                      className="bg-transparent outline-none text-sm w-full text-gray-900 pr-1"
                    />
                    {isSearching ? (
                      <div className="w-3 h-3 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin flex-shrink-0" />
                    ) : searchQuery && (
                      <button 
                        type="button"
                        onClick={clearSearch}
                        className="text-gray-400 hover:text-gray-900 transition-colors flex-shrink-0"
                        title="Limpiar búsqueda"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </form>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {searchResults.length > 0 ? (
                  searchResults.map((res, i) => (
                    <button 
                      key={i}
                      onClick={() => handleSearchResultClick(i)}
                      className={cn(
                        "w-full text-left p-4 rounded-xl mb-2 transition-all border",
                        activeMatchIndex === i ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200" : "bg-white border-gray-100 hover:border-gray-200"
                      )}
                    >
                      <span className={cn(
                        "text-[10px] font-bold",
                        activeMatchIndex === i ? "text-white/80" : "text-gray-400"
                      )}>PÁGINA {res.pageNumber}</span>
                      <p className="text-xs line-clamp-2 mt-1">{res.text}</p>
                    </button>
                  ))
                ) : searchQuery && !isSearching && (
                  <p className="text-center text-xs text-gray-400 py-12">No hay resultados</p>
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>

    {/* SECCIÓN DE DETALLES DEL CATÁLOGO (OUTSIDE THE VIEWER VIEWPORT) */}
    <CatalogViewerDetails 
      title={title}
      coverUrl={currentDoc?.coverUrl || "/images/placeholders/catalog_chaide_1.jpg"}
      numPages={numPages}
      loading={loading}
      downloadPdf={downloadPdf}
      canDownload={!!(url || downloadUrl)}
      pageCount={currentDoc?.pageCount}
      fileSize={currentDoc?.fileSize}
      relatedDocuments={documents.filter(d => d.title !== title).slice(0, 4)}
    />

      <style dangerouslySetInnerHTML={{ __html: `
        .pdf-viewer-shell {
          width: 100%;
          height: calc(100dvh - var(--header-height, 78px));
          overflow: hidden;
          background: #f4f4f2;
        }

        .pdf-reader-page {
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr);
          background: #f4f4f2;
          color: #111;
          overflow: hidden;
          transition: grid-template-columns 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .pdf-reader-page.is-sidebar-collapsed {
          grid-template-columns: 0 minmax(0, 1fr);
        }

        .pdf-reader-page.has-thumbnail-sidebar {
          grid-template-columns: 280px minmax(0, 1fr) 300px;
        }

        .pdf-reader-page.is-sidebar-collapsed.has-thumbnail-sidebar {
          grid-template-columns: 0 minmax(0, 1fr) 300px;
        }

        .pdf-thumbnail-sidebar {
          height: 100%;
          background: rgba(255, 255, 255, 0.96);
          border-left: 1px solid rgba(0, 0, 0, 0.08);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          z-index: 70;
          backdrop-filter: blur(10px);
        }

        .pdf-thumbnail-header {
          height: 72px;
          padding: 0 22px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(0,0,0,0.06);
          flex-shrink: 0;
        }

        .pdf-thumbnail-header span {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.18em;
          color: rgba(0,0,0,0.72);
        }

        .pdf-thumbnail-header button {
          border: 0;
          background: transparent;
          color: rgba(0,0,0,0.42);
          font-size: 24px;
          cursor: pointer;
        }

        .pdf-thumbnail-list {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 24px 20px;
          display: grid;
          grid-template-columns: 1fr;
          gap: 24px;
        }

        .pdf-thumbnail-item {
          border: 0;
          background: transparent;
          display: flex;
          flex-direction: column;
          gap: 10px;
          cursor: pointer;
          text-align: center;
          padding: 10px;
          border-radius: 12px;
          transition: all 200ms ease;
        }

        .pdf-thumbnail-item:hover {
          background: rgba(0,0,0,0.03);
        }

        .pdf-thumbnail-item.is-active {
          background: rgba(37, 99, 235, 0.08);
          box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.5);
        }

        .pdf-thumbnail-canvas-wrapper {
          width: 100%;
          aspect-ratio: 0.72;
          background: #fff;
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.12);
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .pdf-thumbnail-canvas-wrapper canvas {
          width: 100%;
          height: auto;
          display: block;
        }

        .pdf-thumbnail-item span {
          font-size: 10px;
          font-weight: 700;
          color: rgba(0,0,0,0.5);
        }

        .pdf-thumbnail-item.is-active span {
          color: #2563eb;
        }

        @media (max-width: 767px) {
          .pdf-reader-page {
            grid-template-columns: 1fr !important;
          }
          .pdf-thumbnail-sidebar {
            position: fixed;
            top: 0;
            right: 0;
            width: 85vw;
            height: 100dvh;
            box-shadow: -20px 0 50px rgba(0,0,0,0.15);
            z-index: 100;
          }
        }

        .pdf-content-sidebar {
          height: 100%;
          background: rgba(255, 255, 255, 0.94);
          border-right: 1px solid rgba(0, 0, 0, 0.08);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          backdrop-blur: 10px;
        }

        .pdf-content-header {
          height: 72px;
          padding: 0 22px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(0,0,0,0.06);
          flex-shrink: 0;
        }

        .pdf-content-header span {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.18em;
          color: rgba(0,0,0,0.72);
        }

        .pdf-content-header button {
          border: 0;
          background: transparent;
          color: rgba(0,0,0,0.42);
          font-size: 24px;
          cursor: pointer;
        }

        .pdf-content-list {
          flex: 1;
          overflow-y: auto;
          padding: 12px 0;
        }

        .pdf-content-item {
          width: 100%;
          min-height: 40px;
          border: 0;
          background: transparent;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 0 22px;
          cursor: pointer;
          text-align: left;
          transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
          border-radius: 6px;
        }

        .pdf-content-item.is-active {
          background: #2563eb !important;
          color: white !important;
          margin: 0 8px;
          width: calc(100% - 16px);
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
        }

        .pdf-content-item:not(.is-active):hover {
          background: rgba(0,0,0,0.04);
        }

        .pdf-download-card {
          margin: 18px;
          min-height: 68px;
          border-radius: 8px;
          border: 1px solid rgba(0,0,0,0.12);
          background: #fff;
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 0 16px;
          cursor: pointer;
          color: #111;
          text-align: left;
          transition: border-color 200ms ease;
        }
        
        .pdf-download-card:hover {
          border-color: #111;
        }

        .pdf-download-card svg {
          width: 20px;
          height: 20px;
        }

        .pdf-download-card strong {
          display: block;
          font-size: 13px;
          font-weight: 700;
        }

        .pdf-download-card small {
          display: block;
          margin-top: 4px;
          font-size: 11px;
          color: rgba(0,0,0,0.52);
        }

        .pdf-reader-main {
          min-width: 0;
          height: 100%;
          overflow: hidden;
          position: relative;
          background: #f4f4f2;
        }

        .pdf-viewer-container {
          height: 100%;
          width: 100%;
          display: grid;
          grid-template-rows: 72px minmax(0, 1fr) 76px;
          background: 
            radial-gradient(
              circle at center,
              rgba(0,0,0,0.045),
              transparent 42%
            ),
            #f4f4f2;
          flex-shrink: 0;
        }

        .catalog-viewer-details-section {
          background: #f8f8f6;
          border-top: 1px solid rgba(0, 0, 0, 0.08);
          padding: clamp(48px, 5vw, 76px) clamp(48px, 6vw, 96px);
          color: #111;
        }

        .catalog-viewer-details-inner {
          width: min(100%, 1440px);
          margin: 0 auto;
          display: grid;
          grid-template-columns: minmax(420px, 520px) minmax(0, 1fr);
          gap: clamp(56px, 6vw, 96px);
          align-items: start;
        }

        .catalog-main-info {
          display: grid;
          grid-template-columns: 180px minmax(0, 1fr);
          gap: 34px;
          padding-right: clamp(36px, 4vw, 64px);
          border-right: 1px solid rgba(0, 0, 0, 0.10);
        }

        .catalog-info-cover-block h2 {
          margin: 24px 0 0;
          font-size: 24px;
          line-height: 1.05;
          letter-spacing: -0.045em;
          font-weight: 780;
          color: #111;
        }

        .catalog-meta-grid {
          margin-top: 32px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 26px 34px;
        }

        .catalog-meta-item span {
          display: block;
          margin-bottom: 8px;
          font-size: 11px;
          font-weight: 750;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: rgba(0, 0, 0, 0.36);
        }

        .catalog-meta-item strong {
          display: block;
          font-size: 16px;
          line-height: 1.35;
          font-weight: 560;
          color: rgba(0, 0, 0, 0.72);
        }

        .catalog-info-button {
          margin-top: 38px;
          width: min(100%, 260px);
          min-height: 58px;
          border-radius: 14px;
          border: 1px solid rgba(0, 0, 0, 0.12);
          background: #fff;
          color: #111;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: all 200ms ease;
        }

        .catalog-download-info-button {
          margin-top: 38px;
          width: fit-content;
          min-width: 240px;
          border-radius: 16px;
          border: 1px solid rgba(0, 0, 0, 0.10);
          background: #fff;
          cursor: pointer;
          transition: all 240ms cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 12px rgba(0,0,0,0.03);
        }

        .catalog-download-info-button:hover:not(:disabled) {
          border-color: #111;
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.06);
        }

        .catalog-download-info-button:active:not(:disabled) {
          transform: translateY(0);
        }

        .catalog-download-info-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          filter: grayscale(1);
        }

        .catalog-info-button:hover {
          background: #fdfdfd;
          border-color: #111;
        }

        .related-catalogs-block {
          min-width: 0;
        }

        .related-catalogs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          margin-bottom: 36px;
        }

        .related-catalogs-header h2 {
          margin: 0;
          font-size: 26px;
          line-height: 1;
          letter-spacing: -0.045em;
          font-weight: 780;
          color: #111;
        }

        .related-catalogs-row {
          display: grid;
          grid-template-columns: repeat(4, minmax(120px, 1fr));
          gap: clamp(24px, 3vw, 38px);
          align-items: start;
        }

        .related-catalogs-row .catalog-preview-card {
          max-width: 150px;
        }

        .related-catalogs-row .catalog-preview-info {
          margin-top: 14px;
        }

        .related-catalogs-row .catalog-preview-info h3 {
          font-size: 17px;
          line-height: 1.1;
          letter-spacing: -0.035em;
          font-weight: 700;
        }

        .related-catalogs-row .catalog-preview-info p {
          display: none;
        }

        @media (max-width: 1100px) {
          .catalog-viewer-details-inner {
            grid-template-columns: 1fr;
          }

          .catalog-main-info {
            border-right: 0;
            padding-right: 0;
            border-bottom: 1px solid rgba(0, 0, 0, 0.10);
            padding-bottom: 42px;
          }

          .related-catalogs-row {
            grid-template-columns: repeat(2, minmax(110px, 1fr));
          }
        }

        @media (max-width: 767px) {
          .catalog-viewer-details-section {
            padding: 36px 20px 56px;
          }

          .catalog-main-info {
            grid-template-columns: 110px minmax(0, 1fr);
            gap: 20px;
          }

          .catalog-info-cover-block h2 {
            font-size: 18px;
          }

          .catalog-info-meta-block h2 {
            font-size: 28px;
          }

          .catalog-meta-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 18px;
          }

          .related-catalogs-row {
            display: flex;
            gap: 20px;
            overflow-x: auto;
            scroll-snap-type: x mandatory;
            padding-bottom: 12px;
            -webkit-overflow-scrolling: touch;
          }

          .related-catalogs-row .catalog-preview-card {
            flex: 0 0 160px;
            scroll-snap-align: start;
          }
        }

        .pdf-reader-toolbar {
          height: 72px;
          padding: 0 34px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
          align-items: center;
          gap: 24px;
          background: #f4f4f2;
          border-bottom: 1px solid rgba(0,0,0,0.04);
        }

        .pdf-toolbar-left,
        .pdf-toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .pdf-toolbar-left {
          justify-self: start;
        }

        .pdf-toolbar-left > span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .pdf-toolbar-actions {
          justify-self: end;
        }

        .pdf-toolbar-left strong {
          font-size: 14px;
          font-weight: 700;
          color: #111;
          margin-left: 8px;
        }

        .pdf-toolbar-actions button,
        .pdf-toolbar-left button {
          width: 36px;
          height: 36px;
          border: 0;
          border-radius: 999px;
          background: transparent;
          color: rgba(0,0,0,0.68);
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: all 180ms ease;
        }

        .pdf-toolbar-actions button:hover,
        .pdf-toolbar-left button:hover {
          background: rgba(0,0,0,0.055);
          color: #111;
        }

        .pdf-toolbar-actions button.is-active,
        .pdf-toolbar-left button.is-active {
          background: rgba(37, 99, 235, 0.1);
          color: #2563eb;
        }

        .pdf-toolbar-pagination {
          justify-self: center;
          display: flex;
          align-items: center;
          gap: 7px;
          color: #111;
        }

        .pdf-toolbar-pagination > button {
          width: 38px;
          height: 38px;
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.72);
          color: rgba(0, 0, 0, 0.72);
          display: grid;
          place-items: center;
          cursor: pointer;
          transition:
            background-color 160ms ease,
            border-color 160ms ease,
            color 160ms ease,
            transform 160ms ease;
        }

        .pdf-toolbar-pagination > button svg {
          width: 20px;
          height: 20px;
        }

        .pdf-toolbar-pagination > button:hover:not(:disabled) {
          border-color: rgba(0, 85, 184, 0.25);
          background: #fff;
          color: #0055b8;
          transform: translateY(-1px);
        }

        .pdf-toolbar-pagination > button:disabled {
          cursor: not-allowed;
          opacity: 0.32;
        }

        .pdf-toolbar-page-counter {
          height: 40px;
          min-width: 104px;
          padding: 0 11px;
          border: 1px solid rgba(0, 0, 0, 0.11);
          border-radius: 10px;
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          box-shadow: 0 3px 10px rgba(0, 0, 0, 0.04);
          transition:
            border-color 160ms ease,
            box-shadow 160ms ease;
        }

        .pdf-toolbar-page-counter:focus-within {
          border-color: #0055b8;
          box-shadow: 0 0 0 3px rgba(0, 85, 184, 0.12);
        }

        .pdf-toolbar-page-counter input {
          width: 38px;
          min-width: 0;
          padding: 0;
          border: 0;
          outline: 0;
          background: transparent;
          color: #0d3281;
          font: inherit;
          font-size: 14px;
          font-weight: 800;
          line-height: 1;
          text-align: right;
          font-variant-numeric: tabular-nums;
          appearance: textfield;
        }

        .pdf-toolbar-page-counter input:disabled {
          opacity: 0.5;
        }

        .pdf-toolbar-page-counter span,
        .pdf-toolbar-page-counter strong {
          color: rgba(0, 0, 0, 0.48);
          font-size: 13px;
          font-weight: 700;
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }

        .pdf-toolbar-pagination button:focus-visible,
        .pdf-toolbar-page-counter input:focus-visible {
          outline: 2px solid #0055b8;
          outline-offset: 2px;
        }

        @media (max-width: 1100px) {
          .pdf-reader-toolbar {
            padding-inline: 18px;
            gap: 12px;
          }

          .pdf-toolbar-left > span {
            display: none;
          }

          .pdf-toolbar-actions {
            gap: 3px;
          }

          .pdf-toolbar-action--library,
          .pdf-toolbar-action--zoom-out,
          .pdf-toolbar-action--zoom-in,
          .pdf-toolbar-action--fullscreen {
            display: none !important;
          }
        }

        .pdf-stage {
          position: relative;
          min-height: 0;
          display: grid;
          place-items: center;
          padding: 8px 64px 4px;
          overflow: hidden;
          background: 
            radial-gradient(
              ellipse at center,
              rgba(0,0,0,0.055) 0%,
              rgba(0,0,0,0.025) 36%,
              transparent 68%
            );
        }

        .pdf-book-area {
          position: relative;
          width: fit-content;
          max-width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .pdf-book-wrapper {
          position: relative;
          width: min(100%, 1280px);
          height: min(100%, calc(100dvh - 180px));
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .pdf-book-spread {
          position: relative;
          display: flex;
          align-items: stretch;
          justify-content: center;
          box-shadow: 0 30px 60px -12px rgba(0,0,0,0.25), 
                      0 18px 36px -18px rgba(0,0,0,0.3);
          cursor: zoom-in;
          will-change: transform;
        }

        /* A soft, uncoated-paper feel while PageFlip bends each catalog page. */
        .pdf-flipbook .stf__block {
          perspective: 2400px;
        }

        .pdf-flipbook .stf__item.--soft {
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
          filter: saturate(0.995) contrast(0.995);
        }

        .pdf-flipbook .stf__innerShadow,
        .pdf-flipbook .stf__outerShadow {
          filter: blur(0.45px);
        }

        .pdf-book-spread.is-zoomed {
          cursor: grab;
        }

        .pdf-book-spread.is-zoomed:active {
          cursor: grabbing;
        }

        .pdf-book-spread.is-single-page {
          overflow: hidden;
          background: #fff;
          box-shadow: 0 22px 50px -18px rgba(0,0,0,0.32),
                      0 12px 24px -18px rgba(0,0,0,0.36);
        }

        .pdf-book-spread.is-document-single-page {
          background: transparent;
          box-shadow: none;
        }

        .pdf-book-spread.is-document-single-page .page-container {
          border: 0;
          box-shadow: none;
        }

        .pdf-mobile-single-page {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: stretch;
          justify-content: center;
          overflow: hidden;
          background: #fff;
        }

        .pdf-mobile-single-page > .page-container {
          width: 100%;
          height: 100%;
          border-right: 0;
          box-shadow: none;
        }

        .pdf-book-spread::after {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          width: clamp(10px, 1.2vw, 20px);
          transform: translateX(-50%);
          pointer-events: none;
          z-index: 52;
          background:
            linear-gradient(
              90deg,
              rgba(0,0,0,0.14) 0%,
              rgba(0,0,0,0.06) 35%,
              rgba(255,255,255,0.2) 50%,
              rgba(0,0,0,0.06) 65%,
              rgba(0,0,0,0.14) 100%
            );
          opacity: 0.38;
          filter: blur(0.6px);
        }

        .pdf-book-spread.is-single-page::after {
          display: none;
        }

        .pdf-side-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 40px;
          height: 64px;
          border: 0;
          border-radius: 6px;
          background: #111;
          color: #fff;
          z-index: 55;
          cursor: pointer;
          display: grid;
          place-items: center;
          box-shadow: 0 12px 30px rgba(0,0,0,0.3);
          transition: all 200ms ease;
        }

        .pdf-side-nav--prev {
          left: -58px;
        }

        .pdf-side-nav--next {
          right: -58px;
        }

        .pdf-side-nav:hover {
          background: #000;
          transform: translateY(-50%) scale(1.05);
        }
        
        .pdf-side-nav:active {
          transform: translateY(-50%) scale(0.95);
        }

        .pdf-progress-toolbar {
          width: min(100% - 120px, 980px);
          height: 44px;
          margin: 8px auto 20px;
          border-radius: 14px;
          background: #111;
          color: #fff;
          display: grid;
          grid-template-columns: 100px minmax(0, 1fr) 40px;
          align-items: center;
          gap: 20px;
          padding: 0 20px;
          box-shadow: 0 14px 34px rgba(0,0,0,0.25);
          z-index: 50;
        }

        .pdf-progress-toolbar span {
          font-size: 12px;
          font-weight: 700;
          color: rgba(255,255,255,0.86);
        }

        .pdf-progress-slider {
          -webkit-appearance: none;
          width: 100%;
          height: 3px;
          background: rgba(255,255,255,0.15);
          border-radius: 2px;
          outline: none;
          cursor: pointer;
        }
        
        .pdf-progress-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          background: #fff;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(255,255,255,0.5);
          transition: transform 150ms ease;
        }
        
        .pdf-progress-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }

        .pdf-progress-toolbar button {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: #fff;
          display: grid;
          place-items: center;
          cursor: pointer;
          opacity: 0.6;
          transition: opacity 200ms ease;
        }
        
        .pdf-progress-toolbar button:hover {
          opacity: 1;
        }

        @media (max-width: 767px) {
          .pdf-reader-page {
            grid-template-columns: 1fr;
          }

          .pdf-content-sidebar {
            position: fixed;
            inset: 0 auto 0 0;
            width: min(86vw, 300px);
            z-index: 100;
            transform: translateX(-100%);
            transition: transform 220ms ease;
          }

          .pdf-reader-page:not(.is-sidebar-collapsed) .pdf-content-sidebar {
            transform: translateX(0);
          }

          .pdf-reader-main {
            height: 100%;
            grid-template-rows: 60px minmax(0, 1fr) 68px;
          }

          .pdf-reader-toolbar {
            grid-template-columns: 34px minmax(0, auto) minmax(72px, 1fr);
            padding: 0 10px;
            height: 60px;
            gap: 6px;
          }

          .pdf-toolbar-left {
            width: 34px;
          }

          .pdf-toolbar-left button,
          .pdf-toolbar-actions button {
            width: 34px;
            height: 34px;
          }

          .pdf-toolbar-actions {
            gap: 2px;
          }

          .pdf-toolbar-action--library,
          .pdf-toolbar-action--reset,
          .pdf-toolbar-action--zoom-out,
          .pdf-toolbar-action--zoom-in,
          .pdf-toolbar-action--fullscreen {
            display: none !important;
          }

          .pdf-toolbar-pagination {
            gap: 3px;
          }

          .pdf-toolbar-pagination > button {
            width: 30px;
            height: 34px;
            border-radius: 9px;
          }

          .pdf-toolbar-pagination > button svg {
            width: 18px;
            height: 18px;
          }

          .pdf-toolbar-page-counter {
            height: 36px;
            min-width: 76px;
            padding: 0 7px;
            gap: 5px;
            border-radius: 9px;
          }

          .pdf-toolbar-page-counter input {
            width: 26px;
            font-size: 13px;
          }

          .pdf-toolbar-page-counter span,
          .pdf-toolbar-page-counter strong {
            font-size: 12px;
          }

          .pdf-stage {
            padding: 10px 10px 6px;
          }

          .pdf-book-wrapper {
            width: 100%;
            height: 100%;
            max-height: none;
          }

          .pdf-book-spread::after {
            display: none;
          }

          .pdf-side-nav {
            width: 40px;
            height: 40px;
            border-radius: 999px;
          }

          .pdf-side-nav--prev {
            left: 14px;
          }

          .pdf-side-nav--next {
            right: 14px;
          }

          .pdf-progress-toolbar {
            width: calc(100% - 32px);
            margin-bottom: 16px;
            grid-template-columns: auto minmax(0, 1fr);
            gap: 12px;
          }
          
          .pdf-progress-toolbar button {
            display: none;
          }
        }
      ` }} />
    </>
  );
}
