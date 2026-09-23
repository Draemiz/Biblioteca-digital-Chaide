import type { DocumentDef } from './mockData';
import type { PdfIndexItem } from './pdfIndexerService';
import { isFirebaseSite, isStaticSite, staticDataUrl } from './runtimeConfig';

export type CatalogSearchPageData = {
  pageNumber: number;
  text: string;
};

export type PreparedPdfCatalog = {
  pageCount: number;
  pages: CatalogSearchPageData[];
  searchablePages: number;
  generatedCover: File | null;
  indexItems: PdfIndexItem[];
  viewerFile: File;
  viewerOptimization: ViewerPdfOptimization;
};

export type ViewerPdfOptimization = {
  mode: 'original' | 'flattened';
  originalSize: number;
  viewerSize: number;
  imageOperations: number;
  maxImageOperationsPerPage: number;
  reason?: string;
};

function canvasToJpegFile(canvas: HTMLCanvasElement, fileName: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('No se pudo generar la portada desde la primera página.'));
        return;
      }
      resolve(new File([blob], fileName, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.86);
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('No se pudo optimizar una página del PDF.'));
    }, 'image/jpeg', quality);
  });
}

async function createFlattenedViewerPdf(
  source: File,
  pdf: any,
  onProgress?: (progress: number) => void,
) {
  const { PDFDocument } = await import('pdf-lib');
  const output = await PDFDocument.create();
  output.setTitle(source.name.replace(/\.pdf$/i, ''));
  output.setProducer('Chaide Biblioteca Digital');

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const pageSize = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(renderViewport.width));
    canvas.height = Math.max(1, Math.round(renderViewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('El navegador no pudo preparar el PDF optimizado.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    const jpeg = await canvasToJpegBlob(canvas);
    const image = await output.embedJpg(await jpeg.arrayBuffer());
    const outputPage = output.addPage([pageSize.width, pageSize.height]);
    outputPage.drawImage(image, {
      x: 0,
      y: 0,
      width: pageSize.width,
      height: pageSize.height,
    });
    canvas.width = 1;
    canvas.height = 1;
    onProgress?.(76 + Math.round((pageNumber / pdf.numPages) * 23));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
  const fileName = `${source.name.replace(/\.pdf$/i, '') || 'catalogo'}-web.pdf`;
  return new File([new Uint8Array(bytes)], fileName, { type: 'application/pdf' });
}

export function normalizeCatalogSearchText(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanExtractedPdfText(value: string) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200_000);
}

export function shouldOptimizeViewerPdf({
  fileSize,
  pageCount,
  imageOperations,
  maxImageOperationsPerPage,
}: {
  fileSize: number;
  pageCount: number;
  imageOperations: number;
  maxImageOperationsPerPage: number;
}) {
  const safePageCount = Math.max(pageCount, 1);
  const averageImageOperations = imageOperations / safePageCount;
  const imageHeavy = maxImageOperationsPerPage >= 16 || averageImageOperations >= 9;
  const largePerPage = fileSize / safePageCount >= 850 * 1024;
  return imageHeavy && (largePerPage || fileSize >= 12 * 1024 * 1024);
}

export async function preparePdfCatalog(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<PreparedPdfCatalog> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('El archivo seleccionado no es un PDF.');
  }
  if (file.size === 0) throw new Error('El PDF está vacío.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  if (signature !== '%PDF-') throw new Error('El archivo no contiene una estructura PDF válida.');
  onProgress?.(5);

  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }

  const loadingTask = pdfjs.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const pages: CatalogSearchPageData[] = [];
  let generatedCover: File | null = null;
  let indexItems: PdfIndexItem[] = [];
  let imageOperations = 0;
  let maxImageOperationsPerPage = 0;
  let viewerFile = file;

  try {
    const { analyzePdfPageForIndex, buildIndexFromPdfDocument } = await import('./pdfIndexerService');
    const imageOperatorCodes = new Set([
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageMaskXObject,
      pdfjs.OPS.paintSolidColorImageMask,
    ].filter((value): value is number => typeof value === 'number'));
    const pageResults = [];
    if (pdf.numPages < 1) throw new Error('El PDF no contiene páginas.');
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (!(viewport.width > 0 && viewport.height > 0)) {
        throw new Error(`La página ${pageNumber} tiene dimensiones inválidas.`);
      }
      const operatorList = await page.getOperatorList();
      const pageImageOperations = operatorList.fnArray.reduce(
        (total: number, operator: number) => total + (imageOperatorCodes.has(operator) ? 1 : 0),
        0,
      );
      imageOperations += pageImageOperations;
      maxImageOperationsPerPage = Math.max(maxImageOperationsPerPage, pageImageOperations);
      if (pageNumber === 1) {
        const coverScale = Math.min(900 / viewport.width, 1200 / viewport.height, 2);
        const coverViewport = page.getViewport({ scale: coverScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(coverViewport.width));
        canvas.height = Math.max(1, Math.round(coverViewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('El navegador no pudo preparar la portada del PDF.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport: coverViewport }).promise;
        const coverName = `${file.name.replace(/\.pdf$/i, '') || 'catalogo'}-portada.jpg`;
        generatedCover = await canvasToJpegFile(canvas, coverName);
        canvas.width = 1;
        canvas.height = 1;
      }
      // Reuse one page analysis for both the persisted text and smart index.
      // This avoids parsing every page twice on large uploads.
      const pageResult = await analyzePdfPageForIndex(pdf, pageNumber);
      pageResults.push(pageResult);
      const text = cleanExtractedPdfText(pageResult.text);
      pages.push({ pageNumber, text });
      onProgress?.(5 + Math.round((pageNumber / pdf.numPages) * 70));
      if (pageNumber % 4 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    const index = await buildIndexFromPdfDocument(pdf, {
      enableOcr: false,
      pageResults,
    });
    indexItems = index.items;

    const shouldFlatten = shouldOptimizeViewerPdf({
      fileSize: file.size,
      pageCount: pdf.numPages,
      imageOperations,
      maxImageOperationsPerPage,
    });
    if (shouldFlatten) {
      viewerFile = await createFlattenedViewerPdf(file, pdf, onProgress);
    } else {
      onProgress?.(100);
    }
  } finally {
    await pdf.destroy();
  }

  return {
    pageCount: pages.length,
    pages,
    searchablePages: pages.filter((page) => page.text.length > 0).length,
    generatedCover,
    indexItems,
    viewerFile,
    viewerOptimization: {
      mode: viewerFile === file ? 'original' : 'flattened',
      originalSize: file.size,
      viewerSize: viewerFile.size,
      imageOperations,
      maxImageOperationsPerPage,
      ...(viewerFile === file ? {} : {
        reason: 'El PDF contenía demasiadas imágenes o máscaras por página para el visor web.',
      }),
    },
  };
}

export async function loadPersistedCatalogSearchIndex(
  document: Pick<DocumentDef, 'id' | 'pageCount' | 'searchIndexVersion' | 'fileUrl'>,
): Promise<CatalogSearchPageData[]> {
  const loadStaticIndex = async () => {
    try {
      const response = await fetch(
        staticDataUrl(`search-index/${encodeURIComponent(document.id)}.json`),
        { cache: 'force-cache' },
      );
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.pages)
        ? data.pages
          .map((page: CatalogSearchPageData) => ({
            pageNumber: Number(page.pageNumber),
            text: cleanExtractedPdfText(page.text),
          }))
          .filter((page: CatalogSearchPageData) => page.pageNumber > 0)
        : [];
    } catch {
      return [];
    }
  };

  // Historical Hosting PDFs have a matching immutable JSON index in the same
  // deployment. Read it first to avoid hundreds of Firestore document reads
  // per assistant session. Newly uploaded firestore-pdf:// files continue to
  // use their live, versioned Firestore index.
  if (isStaticSite || document.fileUrl?.startsWith('/storage/')) {
    const pages = await loadStaticIndex();
    if (pages.length > 0) return pages;
  }

  if (isFirebaseSite && document.searchIndexVersion) {
    try {
      const { fetchFirebasePdfSearchIndex } = await import('./firebaseCatalog');
      const pages = await fetchFirebasePdfSearchIndex(
        document.id,
        document.searchIndexVersion,
        document.pageCount,
      );
      if (pages.length > 0) return pages;
    } catch (error) {
      console.warn(`[Search] Firestore index unavailable for ${document.id}:`, error);
    }
  }

  if (isStaticSite || isFirebaseSite) {
    return loadStaticIndex();
  }

  return [];
}
