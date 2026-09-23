import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, AlertCircle, Search, X, ArrowRight } from 'lucide-react';
import { useStore } from '../store/useStore';
import { getPdfProxyUrl, detectViewerSource } from '../lib/viewerUtils';
import { getCachedPdfData, setCachedPdfData } from '../lib/backgroundIndexer';
import { isFirebaseSite, isStaticSite } from '../lib/runtimeConfig';
import { getDocumentSearchText } from '../lib/catalogCategories';
import { loadPersistedCatalogSearchIndex } from '../lib/catalogSearchIndex';
import { rankCatalogSearchResults } from '../lib/catalogSearchResults';
import { createCatalogViewerHref } from '../lib/catalogViewerLink';
import {
  applyCatalogSpellingCorrections,
  buildCatalogVocabulary,
  resolveCatalogQueryTokens,
} from '../lib/catalogAssistantSpelling';

// pdfjs is heavy and only needed for the rare client-side fallback indexing
// path (the main search runs server-side via /api/search). Load it lazily so
// the search page bundle stays small.
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib) => {
      if (!lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
      }
      return lib;
    });
  }
  return pdfjsPromise;
}

interface CatalogSearchPage {
  pageNumber: number;
  text: string;
  normalizedText: string;
}

interface CatalogSearchIndex {
  catalogId: string;
  title: string;
  description?: string;
  coverUrl?: string;
  pdfUrl?: string;
  totalPages?: number;
  pages: CatalogSearchPage[];
}

interface GlobalSearchResult {
  catalogId: string;
  title: string;
  description?: string;
  coverUrl?: string;
  totalPages?: number;
  pageNumber: number | null;
  snippet: string;
  matchText: string;
  source: "pdf-content" | "catalog-title" | "catalog-description";
}

const indexCache: Record<string, CatalogSearchIndex> = {};
const RESULTS_PER_PAGE = 20;
const getIndexCacheKey = (doc: any) =>
  `${doc.id}:${doc.searchIndexVersion || doc.fileUrl || 'legacy'}`;

// We can put search highlighter here
function HighlightedText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <span>{text}</span>;
  
  // Normalize highlight for case-insensitive search
  const normalizedHighlight = highlight.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const normalizedText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  const matchIndex = normalizedText.indexOf(normalizedHighlight);
  if (matchIndex === -1) return <span>{text}</span>;

  const start = text.slice(0, matchIndex);
  const match = text.slice(matchIndex, matchIndex + highlight.length);
  const end = text.slice(matchIndex + highlight.length);

  return (
    <span>
      {start}
      <mark className="bg-yellow-200 text-black font-semibold px-1 rounded">{match}</mark>
      {end}
    </span>
  );
}

export default function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = searchParams.get('q') || '';
  
  const { documents, fetchDocuments, hasLoadedDocs, isLoadingDocs, searchQuery, setSearchQuery } = useStore();
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [resolvedQuery, setResolvedQuery] = useState(query);
  const [isSearching, setIsSearching] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState({ current: 0, total: 0 });
  const [usesCatalogFallback, setUsesCatalogFallback] = useState(false);
  const [resultPage, setResultPage] = useState(1);
  const searchRunRef = useRef(0);

  // Keep local input state synchronized with query param
  const [inputValue, setInputValue] = useState(query);

  useEffect(() => {
    setInputValue(query);
    setSearchQuery(query); // Sync global search query state
    setResultPage(1);
  }, [query, setSearchQuery]);

  useEffect(() => {
    if (!isFirebaseSite && !hasLoadedDocs && !isLoadingDocs && documents.length === 0) {
      fetchDocuments();
    }
  }, [documents.length, hasLoadedDocs, isLoadingDocs, fetchDocuments]);

  const normalizeText = (value: string) => {
    return value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const createSnippet = (originalText: string, normalizedText: string, normalizedQuery: string, matchIndex: number) => {
    const CONTEXT_CHARS = 90;
    const start = Math.max(0, matchIndex - CONTEXT_CHARS);
    const end = Math.min(originalText.length, matchIndex + normalizedQuery.length + CONTEXT_CHARS);
    
    let snippet = originalText.slice(start, end).trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < originalText.length) snippet = snippet + '...';
    return snippet;
  };

  const indexPdf = async (doc: any): Promise<CatalogSearchIndex | null> => {
    const cacheKey = getIndexCacheKey(doc);
    if (indexCache[cacheKey]) return indexCache[cacheKey];

    // 1. Check IndexedDB Cache first
    try {
      const cached = await getCachedPdfData(doc.id);
      if (cached) {
        if (cached.failed) {
            console.log(`[Search] Retrying ${doc.title} after previous index failure: ${cached.error}`);
        }

        const cacheMatchesVersion =
          !doc.searchIndexVersion || cached.indexVersion === doc.searchIndexVersion;
        if (cacheMatchesVersion && cached.fullText && cached.fullText.length > 0) {
          console.log(`[Search] Found cached index for ${doc.title}`);
          const index: CatalogSearchIndex = {
            catalogId: doc.id,
            title: doc.title,
            description: doc.description,
            coverUrl: doc.coverUrl,
            totalPages: cached.fullText.length,
            pages: cached.fullText.map(it => ({
              pageNumber: it.page,
              text: it.text,
              normalizedText: normalizeText(it.text)
            }))
          };
          indexCache[cacheKey] = index;
          return index;
        }
      }
    } catch (cacheErr) {
      console.warn('Cache read error:', cacheErr);
    }

    if (isStaticSite || isFirebaseSite) {
      try {
        const pages = await loadPersistedCatalogSearchIndex(doc);
        if (pages.length === 0) return null;
        const index: CatalogSearchIndex = {
          catalogId: doc.id,
          title: doc.title,
          description: doc.description,
          coverUrl: doc.coverUrl,
          pdfUrl: doc.fileUrl,
          totalPages: pages.length,
          pages: pages.map((page: { pageNumber: number; text: string }) => ({
            pageNumber: page.pageNumber,
            text: page.text,
            normalizedText: normalizeText(page.text),
          })),
        };
        await setCachedPdfData(doc.id, {
          items: doc.indexItems || [],
          fullText: pages.map((page) => ({ page: page.pageNumber, text: page.text })),
          lastIndexed: new Date().toISOString(),
          indexVersion: doc.searchIndexVersion,
        });
        indexCache[cacheKey] = index;
        return index;
      } catch {
        return null;
      }
    }

    // 2. Perform on-the-fly indexing if not cached
    const source = detectViewerSource(doc.fileUrl || '');
    if (source.type !== 'pdf-url') return null;

    try {
      const proxiedUrl = getPdfProxyUrl(source.value);
      const absoluteUrl = proxiedUrl.startsWith('/') ? window.location.origin + proxiedUrl : proxiedUrl;
      const encodedUrl = encodeURI(absoluteUrl);
      const pdfjsLib = await loadPdfjs();
      const loadingTask = pdfjsLib.getDocument(encodedUrl);
      const pdf = await loadingTask.promise;
      
      const pages: CatalogSearchPage[] = [];
      const cachedFullText: { page: number, text: string }[] = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item: any) => item.str || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        
        pages.push({
          pageNumber: i,
          text,
          normalizedText: normalizeText(text)
        });

        cachedFullText.push({ page: i, text });
      }

      const index: CatalogSearchIndex = {
        catalogId: doc.id,
        title: doc.title,
        description: doc.description,
        coverUrl: doc.coverUrl,
        pdfUrl: source.value,
        totalPages: pdf.numPages,
        pages
      };

      // Save to cache for next time
      await setCachedPdfData(doc.id, {
        items: [], // Outline not needed for this search index, or can be empty
        fullText: cachedFullText,
        lastIndexed: new Date().toISOString()
      });

      indexCache[cacheKey] = index;
      return index;
    } catch (e: any) {
      console.warn(`Error indexing PDF for ${doc.title}:`, e.message);
      // Fail gracefully: if a PDF is invalid or missing, we just return null so it's skipped in search
      return null;
    }
  };

  const performSearch = useCallback(async () => {
    const searchRun = ++searchRunRef.current;
    const isStale = () => searchRun !== searchRunRef.current;
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery || documents.length === 0) {
      setResults([]);
      setResolvedQuery(query);
      setIsSearching(false);
      return;
    }

    const vocabulary = buildCatalogVocabulary(documents.flatMap((document) => [
      { text: document.title || '', weight: 20 },
      { text: document.description || '', weight: 6 },
      { text: document.category || '', weight: 12 },
      { text: (document.tags || []).join(' '), weight: 12 },
    ]));
    const resolution = resolveCatalogQueryTokens(normalizedQuery.split(/\s+/), vocabulary);
    const correctedQuery = normalizeText(applyCatalogSpellingCorrections(query, resolution.corrections));
    const effectiveQuery = correctedQuery || normalizedQuery;
    const queryTokens = effectiveQuery.split(/\s+/).filter(Boolean);
    const findMatch = (text: string) => {
      const exact = text.indexOf(effectiveQuery);
      if (exact >= 0) return exact;
      if (queryTokens.length > 1 && queryTokens.every((token) => text.includes(token))) {
        return Math.min(...queryTokens.map((token) => text.indexOf(token)).filter((index) => index >= 0));
      }
      return -1;
    };
    setResolvedQuery(resolution.corrections.length > 0 ? effectiveQuery : query);

    setIsSearching(true);
    setUsesCatalogFallback(false);
    const searchResults: GlobalSearchResult[] = [];

    if (!isStaticSite && !isFirebaseSite) {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (isStale()) return;
          if (Array.isArray(data.results)) {
            setIndexingProgress({ current: data.totalPdf || 0, total: data.totalPdf || 0 });
            setResults(rankCatalogSearchResults(data.results as GlobalSearchResult[]));
            setIsSearching(false);
            return;
          }
        }
      } catch (serverSearchError) {
        console.warn('Server search failed, using browser fallback:', serverSearchError);
      }
    }

    // 1. Initial Quick Search (Title/Description)
    documents.forEach(doc => {
      const normTitle = normalizeText(doc.title);
      const normDesc = normalizeText(doc.description || '');
      const normMetadata = getDocumentSearchText(doc);

      if (findMatch(normTitle) >= 0) {
        searchResults.push({
          catalogId: doc.id,
          title: doc.title,
          description: doc.description,
          coverUrl: doc.coverUrl,
          totalPages: doc.pageCount,
          pageNumber: 1,
          snippet: doc.title,
          matchText: query,
          source: 'catalog-title'
        });
      } else if (findMatch(normDesc) >= 0) {
        searchResults.push({
          catalogId: doc.id,
          title: doc.title,
          description: doc.description,
          coverUrl: doc.coverUrl,
          totalPages: doc.pageCount,
          pageNumber: 1,
          snippet: doc.description || '',
          matchText: query,
          source: 'catalog-description'
        });
      } else if (findMatch(normMetadata) >= 0) {
        searchResults.push({
          catalogId: doc.id,
          title: doc.title,
          description: doc.description,
          coverUrl: doc.coverUrl,
          totalPages: doc.pageCount,
          pageNumber: 1,
          snippet: [doc.category, ...(doc.tags || [])].filter(Boolean).join(' · '),
          matchText: query,
          source: 'catalog-description'
        });
      }
    });

    const pdfDocs = documents.filter(doc => detectViewerSource(doc.fileUrl || '').type === 'pdf-url');
    const totalPdf = pdfDocs.length;
    setIndexingProgress({ current: 0, total: totalPdf });

    // 2. Initial Parallel Cache Check
    const cachedIndexes = await Promise.all(pdfDocs.map(async doc => {
      const cacheKey = getIndexCacheKey(doc);
      if (indexCache[cacheKey]) return { doc, index: indexCache[cacheKey] };
      const cached = await getCachedPdfData(doc.id);
      const cacheMatchesVersion =
        !doc.searchIndexVersion || cached?.indexVersion === doc.searchIndexVersion;
      if (cached && cacheMatchesVersion && cached.fullText && cached.fullText.length > 0) {
        const index: CatalogSearchIndex = {
          catalogId: doc.id,
          title: doc.title,
          description: doc.description,
          coverUrl: doc.coverUrl,
          totalPages: cached.fullText.length,
          pages: cached.fullText.map(it => ({
            pageNumber: it.page,
            text: it.text,
            normalizedText: normalizeText(it.text)
          }))
        };
        indexCache[cacheKey] = index;
        return { doc, index };
      }
      return { doc, index: null };
    }));
    if (isStale()) return;

    // Process cached matches immediately
    cachedIndexes.forEach(({ doc, index }) => {
      if (index) {
        for (const page of index.pages) {
          const matchIdx = findMatch(page.normalizedText);
          if (matchIdx !== -1) {
            searchResults.push({
              catalogId: doc.id,
              title: doc.title,
              description: doc.description,
              coverUrl: doc.coverUrl,
              totalPages: index.totalPages,
              pageNumber: page.pageNumber,
              snippet: createSnippet(page.text, page.normalizedText, effectiveQuery, matchIdx),
              matchText: effectiveQuery,
              source: 'pdf-content'
            });
          }
        }
      }
    });

    setResults(rankCatalogSearchResults(searchResults));

    if (isFirebaseSite) {
      try {
        const { searchFirebaseCatalogPages } = await import('../lib/firebaseCatalog');
        const matchingPages = await searchFirebaseCatalogPages(queryTokens);
        if (isStale()) return;
        const documentsById = new Map(documents.map((document) => [document.id, document]));
        for (const page of matchingPages) {
          const doc = documentsById.get(page.catalogId);
          const usesStaticIndex = doc?.fileUrl?.startsWith('/storage/');
          if (!doc || (!usesStaticIndex && doc.searchIndexVersion && page.version !== doc.searchIndexVersion)) continue;
          const normalizedPageText = normalizeText(page.text);
          const matchIdx = findMatch(normalizedPageText);
          if (matchIdx < 0) continue;
          searchResults.push({
            catalogId: doc.id,
            title: doc.title,
            description: doc.description,
            coverUrl: doc.coverUrl,
            totalPages: doc.pageCount,
            pageNumber: page.pageNumber,
            snippet: createSnippet(page.text, normalizedPageText, effectiveQuery, matchIdx),
            matchText: effectiveQuery,
            source: 'pdf-content',
          });
        }
        setIndexingProgress({ current: documents.length, total: documents.length });
        setResults(rankCatalogSearchResults(searchResults));
        setIsSearching(false);
        return;
      } catch (error) {
        if (isStale()) return;
        // Older deployments without the global index keep the proven per-PDF
        // path as a compatibility fallback while an administrator backfills it.
        console.warn('[Search] Global index unavailable, using catalogue indexes.', error);
        setUsesCatalogFallback(true);
      }
    }

    // 3. Fallback: On-the-fly Indexing for missing ones
    const missingDocs = cachedIndexes.filter(it => !it.index).map(it => it.doc);
    
    if (missingDocs.length > 0) {
      let completedIndexes = totalPdf - missingDocs.length;
      // Limit concurrent index downloads. A large library should not open
      // hundreds of Firestore/static requests at once on a phone.
      for (let start = 0; start < missingDocs.length; start += 3) {
        await Promise.all(missingDocs.slice(start, start + 3).map(async (doc) => {
        const index = await indexPdf(doc);
        if (isStale()) return;
        completedIndexes += 1;
        setIndexingProgress({ current: completedIndexes, total: totalPdf });
        if (index) {
          let foundNewMatches = false;
          for (const page of index.pages) {
            const matchIdx = findMatch(page.normalizedText);
            if (matchIdx !== -1) {
              searchResults.push({
                catalogId: doc.id,
                title: doc.title,
                description: doc.description,
                coverUrl: doc.coverUrl,
                totalPages: index.totalPages,
                pageNumber: page.pageNumber,
                snippet: createSnippet(page.text, page.normalizedText, effectiveQuery, matchIdx),
                matchText: effectiveQuery,
                source: 'pdf-content'
              });
              foundNewMatches = true;
            }
          }

          if (foundNewMatches) {
            setResults(rankCatalogSearchResults(searchResults));
          }
        }
        }));
        if (isStale()) return;
      }
    }

    if (isStale()) return;
    setResults(rankCatalogSearchResults(searchResults));
    setIsSearching(false);
  }, [query, documents]);

  useEffect(() => {
    if (documents && documents.length > 0) {
      performSearch();
    }
  }, [performSearch, documents]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      setSearchParams({ q: inputValue.trim() });
    }
  };

  const handleClear = () => {
    setInputValue('');
    setSearchQuery('');
    setSearchParams({});
    setResults([]);
    setResultPage(1);
  };

  const totalResultPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
  const visibleResultPage = Math.min(resultPage, totalResultPages);
  const visibleResults = useMemo(() => {
    const start = (visibleResultPage - 1) * RESULTS_PER_PAGE;
    return results.slice(start, start + RESULTS_PER_PAGE);
  }, [results, visibleResultPage]);
  const visibleResultStart = results.length
    ? (visibleResultPage - 1) * RESULTS_PER_PAGE + 1
    : 0;
  const visibleResultEnd = Math.min(visibleResultPage * RESULTS_PER_PAGE, results.length);

  const changeResultPage = (nextPage: number) => {
    setResultPage(Math.max(1, Math.min(totalResultPages, nextPage)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main className="min-h-screen pt-24 pb-20 px-4 md:px-8 bg-white" style={{ color: '#111', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", sans-serif' }}>
      <div className="max-w-[1000px] mx-auto">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <button 
              onClick={() => navigate('/')}
              className="text-[#111] hover:text-black transition-colors"
              aria-label="Volver"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-3xl font-bold tracking-tight">Páginas encontradas</h1>
          </div>
          <div className="text-gray-500 ml-9 flex gap-2 text-sm">
            <span>{results.length} resultados en la biblioteca</span>
            <span>•</span>
            <span>Total de catálogos buscados</span>
          </div>
          {resolvedQuery && normalizeText(resolvedQuery) !== normalizeText(query) && (
            <p className="ml-9 mt-2 text-sm text-[#0055b8]">
              Interpretando la búsqueda como “{resolvedQuery}”.
            </p>
          )}
        </header>

        {/* Search Bar matching the reference image */}
        <div className="flex flex-col sm:flex-row gap-4 mb-8">
          <form onSubmit={handleSearchSubmit} className="flex-1 relative flex items-center">
            <div className="absolute left-4 text-gray-500 pointer-events-none">
              <Search className="w-5 h-5" />
            </div>
            <input 
              type="text" 
              className="w-full h-14 pl-12 pr-32 rounded-xl border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none transition-all text-lg"
              placeholder="Buscar catálogos..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            {inputValue && (
              <button 
                type="button"
                onClick={handleClear}
                className="absolute right-24 w-6 h-6 bg-gray-400 hover:bg-gray-500 text-white rounded-full flex items-center justify-center transition-colors"
                aria-label="Borrar búsqueda"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="absolute right-2 h-10 px-4 rounded-lg bg-[#111] text-white text-sm font-semibold hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Buscar
            </button>
          </form>
        </div>

        {isSearching && (
          <div className="py-20 flex flex-col items-center justify-center gap-4 text-center">
            <Loader2 className="w-10 h-10 text-[#111] animate-spin" />
            <div>
              <p className="text-lg font-medium">Buscando...</p>
              <p className="text-sm text-[#111]/50 mt-1">
                {usesCatalogFallback
                  ? `Recuperando índices: ${indexingProgress.current} de ${indexingProgress.total}`
                  : 'Consultando el índice actualizado…'}
              </p>
            </div>
          </div>
        )}

        {!isSearching && results.length === 0 && query && (
          <div className="py-20 text-center flex flex-col items-center gap-4 border border-dashed border-[#111]/10 rounded-2xl bg-gray-50">
            <AlertCircle className="w-12 h-12 text-[#111]/20" />
            <p className="text-xl text-[#111]/50">No se encontraron resultados para “{query}”</p>
          </div>
        )}

        {/* Results List */}
        {!isSearching && results.length > 0 && (
          <div className="flex flex-col border border-gray-200 rounded-2xl overflow-hidden divide-y divide-gray-200 bg-white shadow-sm mb-8">
            {visibleResults.map((result, idx) => (
              <button
                type="button"
                key={`${result.catalogId}-${result.pageNumber}-${idx}`}
                className="flex w-full flex-col sm:flex-row gap-6 p-6 hover:bg-gray-50 transition-colors cursor-pointer group text-left active:scale-[0.995]"
                onClick={() => navigate(createCatalogViewerHref({
                  catalogId: result.catalogId,
                  pageNumber: result.pageNumber,
                  search: resolvedQuery || query,
                }))}
                aria-label={result.source === 'pdf-content'
                  ? `Abrir ${result.title}, página ${result.pageNumber}`
                  : `Abrir catálogo ${result.title}`}
              >
                <div className="w-full sm:w-48 h-32 flex-shrink-0 bg-gray-100 rounded-xl overflow-hidden border border-gray-200 flex items-center justify-center">
                  <img src={result.coverUrl || '/placeholder.jpg'} alt={result.title} className="w-full h-full object-contain" />
                </div>
                
                <div className="flex-1 flex flex-col justify-center">
                  <h3 className="text-xl font-bold text-gray-900 mb-1">
                    {result.source === 'pdf-content' ? `Página ${result.pageNumber}` : 'Catálogo'}
                  </h3>
                  <p className="text-sm text-gray-500 mb-3">{result.title}</p>
                  
                  <p className="text-gray-700 leading-relaxed max-w-3xl">
                    <HighlightedText text={result.snippet} highlight={resolvedQuery || query} />
                  </p>
                  
                  <div className="mt-4 flex gap-2">
                    <span className="px-3 py-1.5 bg-gray-100 text-gray-700 text-xs rounded-lg font-medium">
                      {result.source === 'pdf-content'
                        ? `Abrir página ${result.pageNumber}`
                        : 'Abrir catálogo'}
                    </span>
                  </div>
                </div>

                <div className="hidden sm:flex items-center justify-center">
                  <div className="w-10 h-10 flex items-center justify-center rounded-full border border-gray-300 text-gray-500 group-hover:border-black group-hover:text-black transition-colors">
                    <ArrowRight className="w-5 h-5" aria-hidden="true" />
                  </div>
                </div>
              </button>
            ))}
            
            {/* Footer Pagination */}
            <div className="p-4 bg-gray-50 flex items-center justify-between text-sm text-gray-600">
              <div>
                {visibleResultStart}-{visibleResultEnd} de {results.length} resultados
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => changeResultPage(visibleResultPage - 1)}
                  disabled={visibleResultPage <= 1}
                  aria-label="Página anterior de resultados"
                  className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  aria-current="page"
                  className="min-w-8 h-8 px-2 flex items-center justify-center rounded border border-black bg-black text-white font-medium"
                >
                  {visibleResultPage} / {totalResultPages}
                </button>
                <button
                  type="button"
                  onClick={() => changeResultPage(visibleResultPage + 1)}
                  disabled={visibleResultPage >= totalResultPages}
                  aria-label="Página siguiente de resultados"
                  className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
