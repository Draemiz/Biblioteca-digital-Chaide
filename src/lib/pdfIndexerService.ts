import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface PdfIndexItem {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  source: "outline" | "auto" | "ocr";
  score?: number;
  ocrConfidence?: number;
  children?: PdfIndexItem[];
}

export interface SmartIndexResult {
  items: PdfIndexItem[];
  source: PdfIndexItem['source'] | null;
  fullTextLength: number;
  usedOcr: boolean;
}

type CandidateSource = "auto" | "ocr";

export interface HeadingCandidate {
  text: string;
  normalized: string;
  pageNumber: number;
  source: CandidateSource;
  fontSize: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  score: number;
  confidence?: number;
}

export interface PageCandidateResult {
  pageNumber: number;
  fullTextLength: number;
  text: string;
  candidates: HeadingCandidate[];
}

const NOISE_WORDS = new Set([
  'chaide',
  'biblioteca digital',
  'catalogo',
  'catalogos',
  'pdf',
  'pagina',
  'page',
  'www',
]);

const SECTION_WORDS = [
  'coleccion',
  'linea',
  'producto',
  'productos',
  'dormitorio',
  'descanso',
  'textil',
  'textiles',
  'sabanas',
  'toallas',
  'colchones',
  'almohadas',
  'protectores',
  'manual',
  'guia',
  'indice',
  'contenido',
  'caracteristicas',
  'beneficios',
  'especificaciones',
];

export const normalizeText = (value: string) => {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const cleanHeadingText = (value: string) => {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.|/_-]+|[\s:;,.|/_-]+$/g, "")
    .trim();
};

export const isPageNumber = (text: string) => /^\d{1,3}$|^(p|pag|pagina)\.?\s?\d{1,3}$/i.test(text.trim());
export const isPrice = (text: string) => /[$\u20ac\u00a3]\s?\d+([.,]\d{2})?|\d+([.,]\d{2})?\s?[$\u20ac\u00a3]/.test(text.trim());
export const isUrl = (text: string) => /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/.test(text.trim());
export const isEmail = (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
export const isPhone = (text: string) => /(\+?\d{1,4}[\s-])?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/.test(text.trim());

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
};

const uppercaseRatio = (text: string) => {
  const letters = [...text].filter(char => /\p{L}/u.test(char));
  if (letters.length === 0) return 0;
  return letters.filter(char => char === char.toUpperCase()).length / letters.length;
};

export const looksLikeTitle = (text: string) => {
  const trimmed = cleanHeadingText(text);
  if (trimmed.length < 3) return false;
  if (uppercaseRatio(trimmed) > 0.78 && /[A-ZÁÉÍÓÚÑ]/.test(trimmed)) return true;

  const words = trimmed.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;

  const titleCaseWords = words.filter(word => {
    const first = word[0];
    return first && first === first.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(first);
  });

  return titleCaseWords.length / words.length >= 0.65;
};

const isMostlyNumeric = (text: string) => {
  const compact = text.replace(/\s/g, '');
  if (!compact) return false;
  const numeric = compact.replace(/[^\d.,%/-]/g, '').length;
  return numeric / compact.length > 0.55;
};

const hasLowInformationRepetition = (words: string[]) => {
  if (words.length < 4) return false;
  const uniqueWords = new Set(words);
  const shortFragments = words.filter(word => word.length <= 3).length;
  return uniqueWords.size / words.length < 0.55 || shortFragments / words.length > 0.5;
};

const isWeakHeadingText = (text: string) => {
  const cleaned = cleanHeadingText(text);
  const normalized = normalizeText(cleaned);
  const words = normalized.split(' ').filter(Boolean);

  if (cleaned.length < 4) return true;
  if (cleaned.length > 86) return true;
  if (words.length > 12) return true;
  if (hasLowInformationRepetition(words)) return true;
  if (isMostlyNumeric(cleaned)) return true;
  if (/^\d+\s*(piezas?|pcs|unidades?)$/.test(normalized)) return true;
  if (/\bagotad[oa]s?\b/.test(normalized)) return true;
  if (isPageNumber(cleaned) || isPrice(cleaned) || isUrl(cleaned) || isEmail(cleaned) || isPhone(cleaned)) return true;
  if (NOISE_WORDS.has(normalized)) return true;
  if (/^(fecha|telefono|tel|email|correo|direccion|ruc|codigo|sku|ref)\b/i.test(normalized)) return true;
  if (/^[•\-–—_*]+$/.test(cleaned)) return true;

  return false;
};

const getLineCandidatesFromPdfText = (textContent: any, pageNumber: number, pageWidth: number, pageHeight: number): PageCandidateResult => {
  const rawItems = (textContent.items || [])
    .map((item: any) => {
      if (!item || typeof item.str !== 'string') return null;
      const text = cleanHeadingText(item.str);
      if (!text) return null;

      const fontSize = Math.max(
        Math.sqrt(Math.pow(item.transform?.[0] || 0, 2) + Math.pow(item.transform?.[1] || 0, 2)),
        item.height || 0,
        1
      );

      return {
        text,
        fontSize,
        x: item.transform?.[4] || 0,
        y: pageHeight - (item.transform?.[5] || 0),
        width: item.width || 0,
        height: item.height || fontSize,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x);

  const fullTextLength = rawItems.reduce((sum: number, item: any) => sum + item.text.length, 0);
  const text = rawItems.map((item: any) => item.text).join(' ');
  const lines: any[] = [];

  for (const item of rawItems) {
    const last = lines[lines.length - 1];
    const tolerance = Math.max(4, item.fontSize * 0.45);
    if (last && Math.abs(last.y - item.y) <= tolerance) {
      last.items.push(item);
      last.y = (last.y + item.y) / 2;
      last.fontSize = Math.max(last.fontSize, item.fontSize);
    } else {
      lines.push({ y: item.y, fontSize: item.fontSize, items: [item] });
    }
  }

  const fontSizes = rawItems.map((item: any) => item.fontSize).filter((size: number) => size > 0);
  const medianFontSize = quantile(fontSizes, 0.5) || 10;
  const highFontSize = quantile(fontSizes, 0.78) || medianFontSize;

  const candidates = lines.map((line, index) => {
    const items = line.items.sort((a: any, b: any) => a.x - b.x);
    const text = cleanHeadingText(items.map((item: any) => item.text).join(' '));
    const x0 = Math.min(...items.map((item: any) => item.x));
    const x1 = Math.max(...items.map((item: any) => item.x + item.width));
    const y0 = Math.min(...items.map((item: any) => item.y - item.height));
    const y1 = Math.max(...items.map((item: any) => item.y));

    return createCandidate({
      text,
      pageNumber,
      source: 'auto',
      fontSize: Math.max(line.fontSize, highFontSize),
      x: x0,
      y: Math.max(0, y0),
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
      pageWidth,
      pageHeight,
      lineIndex: index,
      medianFontSize,
      highFontSize,
    });
  }).filter(Boolean) as HeadingCandidate[];

  return { pageNumber, fullTextLength, text, candidates };
};

const createCandidate = ({
  text,
  pageNumber,
  source,
  fontSize,
  x,
  y,
  width,
  height,
  pageWidth,
  pageHeight,
  lineIndex,
  medianFontSize,
  highFontSize,
  confidence,
}: {
  text: string;
  pageNumber: number;
  source: CandidateSource;
  fontSize: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  lineIndex: number;
  medianFontSize: number;
  highFontSize: number;
  confidence?: number;
}) => {
  const cleaned = cleanHeadingText(text);
  const normalized = normalizeText(cleaned);
  if (isWeakHeadingText(cleaned)) return null;

  const wordCount = normalized.split(' ').filter(Boolean).length;
  const fontRatio = fontSize / Math.max(medianFontSize, 1);
  const topRatio = y / Math.max(pageHeight, 1);
  const centered = Math.abs((x + width / 2) - pageWidth / 2) / pageWidth < 0.18;
  const hasSectionWord = SECTION_WORDS.some(word => normalized.includes(word));
  const endsLikeSentence = /[.!?]$/.test(cleaned) && wordCount > 6;

  let score = 0;
  if (fontRatio >= 2.2) score += 7;
  else if (fontRatio >= 1.65) score += 5;
  else if (fontRatio >= 1.25) score += 3;
  else if (fontSize >= highFontSize) score += 2;

  if (topRatio <= 0.18) score += 4;
  else if (topRatio <= 0.36) score += 2;
  else if (topRatio >= 0.78) score -= 4;

  if (looksLikeTitle(cleaned)) score += 3;
  if (uppercaseRatio(cleaned) > 0.72) score += 2;
  if (centered) score += 2;
  if (hasSectionWord) score += 2;
  if (wordCount >= 2 && wordCount <= 7) score += 2;
  if (wordCount === 1 && cleaned.length >= 8) score += 1;
  if (wordCount > 9) score -= 3;
  if (endsLikeSentence) score -= 3;
  if (lineIndex > 8 && topRatio > 0.42) score -= 2;

  if (source === 'ocr') {
    score += 1;
    if (typeof confidence === 'number' && confidence < 55) score -= 3;
  }

  if (score < 6) return null;

  return {
    text: cleaned,
    normalized,
    pageNumber,
    source,
    fontSize,
    x,
    y,
    width,
    height,
    pageWidth,
    pageHeight,
    score,
    confidence,
  } satisfies HeadingCandidate;
};

export const analyzePdfPageForIndex = async (pdfDoc: pdfjsLib.PDFDocumentProxy, pageNumber: number): Promise<PageCandidateResult> => {
  const page = await pdfDoc.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  return getLineCandidatesFromPdfText(textContent, pageNumber, viewport.width, viewport.height);
};

const createOcrWorker = async () => {
  const tesseract = await import('tesseract.js') as any;
  const worker = await tesseract.createWorker(['spa', 'eng'], 1, {
    logger: () => undefined,
  });

  if (worker?.setParameters && tesseract.PSM?.SPARSE_TEXT) {
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
    });
  }

  return worker;
};

const getOcrCandidates = async (
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumbers: number[],
): Promise<PageCandidateResult[]> => {
  if (typeof document === 'undefined' || pageNumbers.length === 0) return [];

  let worker: any = null;
  const results: PageCandidateResult[] = [];

  try {
    worker = await createOcrWorker();

    for (const pageNumber of pageNumbers) {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) continue;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: context, viewport }).promise;

      const ocrResult = await worker.recognize(
        canvas,
        {
          rectangle: {
            left: 0,
            top: 0,
            width: canvas.width,
            height: Math.floor(canvas.height * 0.62),
          },
        },
        { text: true, blocks: true },
      );

      const pageWidth = viewport.width / 1.8;
      const pageHeight = viewport.height / 1.8;
      const lines: any[] = [];

      for (const block of ocrResult?.data?.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const line of paragraph.lines || []) {
            if (line?.text) lines.push(line);
          }
        }
      }

      if (lines.length === 0 && ocrResult?.data?.text) {
        ocrResult.data.text
          .split('\n')
          .map((line: string) => cleanHeadingText(line))
          .filter(Boolean)
          .forEach((line: string, index: number) => {
            lines.push({
              text: line,
              confidence: ocrResult.data.confidence,
              bbox: {
                x0: canvas.width * 0.08,
                x1: canvas.width * 0.92,
                y0: 26 + index * 36,
                y1: 56 + index * 36,
              },
            });
          });
      }

      const fontSizes = lines.map(line => Math.max(1, (line.bbox?.y1 || 0) - (line.bbox?.y0 || 0)) / 1.8);
      const medianFontSize = quantile(fontSizes, 0.5) || 12;
      const highFontSize = quantile(fontSizes, 0.78) || medianFontSize;

      const candidates = lines.map((line, index) => {
        const bbox = line.bbox || { x0: 0, y0: 0, x1: canvas.width, y1: 24 };
        return createCandidate({
          text: line.text || '',
          pageNumber,
          source: 'ocr',
          fontSize: Math.max(1, bbox.y1 - bbox.y0) / 1.8,
          x: bbox.x0 / 1.8,
          y: bbox.y0 / 1.8,
          width: Math.max(1, bbox.x1 - bbox.x0) / 1.8,
          height: Math.max(1, bbox.y1 - bbox.y0) / 1.8,
          pageWidth,
          pageHeight,
          lineIndex: index,
          medianFontSize,
          highFontSize,
          confidence: line.confidence,
        });
      }).filter(Boolean) as HeadingCandidate[];

      results.push({
        pageNumber,
        fullTextLength: ocrResult?.data?.text?.length || 0,
        text: String(ocrResult?.data?.text || ''),
        candidates,
      });

      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    console.warn('OCR index fallback failed:', error);
  } finally {
    await worker?.terminate?.().catch(() => undefined);
  }

  return results;
};

const removeRepeatedNoise = (candidates: HeadingCandidate[], totalPages: number) => {
  const appearances = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    if (!appearances.has(candidate.normalized)) appearances.set(candidate.normalized, new Set());
    appearances.get(candidate.normalized)!.add(candidate.pageNumber);
  }

  const repeatedLimit = Math.max(3, Math.ceil(totalPages * 0.28));
  return candidates.filter(candidate => {
    const pageSet = appearances.get(candidate.normalized);
    const repeatedAcrossDocument = pageSet && pageSet.size >= repeatedLimit;
    if (!repeatedAcrossDocument) return true;

    const strongSectionSignal = candidate.score >= 12 && SECTION_WORDS.some(word => candidate.normalized.includes(word));
    return strongSectionSignal;
  });
};

const dedupeCandidates = (candidates: HeadingCandidate[]) => {
  const sorted = candidates.sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return b.score - a.score;
  });

  const selected: HeadingCandidate[] = [];

  for (const candidate of sorted) {
    const samePage = selected.some(item => item.pageNumber === candidate.pageNumber);
    if (samePage && candidate.score < 11) continue;

    const tooSimilar = selected.some(item => {
      if (item.normalized === candidate.normalized) return true;
      if (Math.abs(item.pageNumber - candidate.pageNumber) > 2) return false;
      return item.normalized.includes(candidate.normalized) || candidate.normalized.includes(item.normalized);
    });

    if (!tooSimilar) selected.push(candidate);
  }

  return selected.slice(0, 90);
};

const candidatesToIndexItems = (candidates: HeadingCandidate[]): PdfIndexItem[] => {
  const sizes = candidates.map(candidate => candidate.fontSize);
  const level0 = quantile(sizes, 0.72);
  const level1 = quantile(sizes, 0.42);

  return candidates.map(candidate => {
    let level = 2;
    if (candidate.fontSize >= level0 || candidate.score >= 13) level = 0;
    else if (candidate.fontSize >= level1 || candidate.score >= 10) level = 1;

    return {
      id: `${candidate.source}-${candidate.pageNumber}-${candidate.normalized.replace(/\s+/g, '-').slice(0, 48)}`,
      title: candidate.text,
      pageNumber: candidate.pageNumber,
      level,
      source: candidate.source,
      score: candidate.score,
      ocrConfidence: candidate.confidence,
    };
  });
};

const resolveOutlineItems = async (pdfDoc: pdfjsLib.PDFDocumentProxy): Promise<PdfIndexItem[]> => {
  const outline = await pdfDoc.getOutline();
  if (!outline || !Array.isArray(outline) || outline.length === 0) return [];

  const items: PdfIndexItem[] = [];
  const resolveItems = async (outlineItems: any[], level = 0) => {
    if (!Array.isArray(outlineItems)) return;
    for (const item of outlineItems) {
      let pageNumber: number | null = null;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
        if (Array.isArray(dest)) {
          const pageRef = dest[0];
          const pageIdx = await pdfDoc.getPageIndex(pageRef);
          pageNumber = pageIdx + 1;
        }
      } catch {
        pageNumber = null;
      }

      const title = cleanHeadingText(item.title || '');
      if (pageNumber && title && !isWeakHeadingText(title)) {
        items.push({
          id: `outline-${pageNumber}-${normalizeText(title).replace(/\s+/g, '-').slice(0, 48)}`,
          title,
          pageNumber,
          level,
          source: 'outline',
          score: 20,
        });
      }
      if (item.items && Array.isArray(item.items) && item.items.length > 0) {
        await resolveItems(item.items, level + 1);
      }
    }
  };

  await resolveItems(outline);
  return items.sort((a, b) => a.pageNumber - b.pageNumber);
};

export const buildIndexFromPdfDocument = async (
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  options: { enableOcr?: boolean; maxOcrPages?: number; pageResults?: PageCandidateResult[] } = {},
): Promise<SmartIndexResult> => {
  const outlineItems = await resolveOutlineItems(pdfDoc);
  if (outlineItems.length > 0) {
    return {
      items: outlineItems,
      source: 'outline',
      fullTextLength: 0,
      usedOcr: false,
    };
  }

  const pageResults: PageCandidateResult[] = options.pageResults
    ? [...options.pageResults]
    : [];
  if (!options.pageResults) {
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      pageResults.push(await analyzePdfPageForIndex(pdfDoc, pageNumber));
      if (pageNumber % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  let fullTextLength = pageResults.reduce((sum, page) => sum + page.fullTextLength, 0);

  let candidates = pageResults.flatMap(page => page.candidates);
  let usedOcr = candidates.some((candidate) => candidate.source === 'ocr');

  if (options.enableOcr !== false && (fullTextLength < 80 || candidates.length === 0)) {
    const maxOcrPages = Math.min(options.maxOcrPages || 8, pdfDoc.numPages);
    const pagesToScan = Array.from({ length: maxOcrPages }, (_, index) => index + 1);
    const ocrResults = await getOcrCandidates(pdfDoc, pagesToScan);
    const ocrCandidates = ocrResults.flatMap(page => page.candidates);
    const ocrTextLength = ocrResults.reduce((sum, page) => sum + page.fullTextLength, 0);
    if (ocrCandidates.length > 0) {
      candidates = ocrCandidates;
      fullTextLength = Math.max(fullTextLength, ocrTextLength);
      usedOcr = true;
    }
  }

  candidates = removeRepeatedNoise(candidates, pdfDoc.numPages)
    .filter(candidate => candidate.score >= (candidate.source === 'ocr' ? 7 : 6));

  const selected = dedupeCandidates(candidates);
  const items = candidatesToIndexItems(selected).sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return a.level - b.level;
  });

  return {
    items,
    source: usedOcr ? 'ocr' : (items.length > 0 ? 'auto' : null),
    fullTextLength,
    usedOcr,
  };
};

export const buildIndexDirectly = async (url: string): Promise<PdfIndexItem[]> => {
  const loadingTask = pdfjsLib.getDocument(url);
  const pdfDoc = await loadingTask.promise;

  try {
    const result = await buildIndexFromPdfDocument(pdfDoc, { enableOcr: true, maxOcrPages: 8 });
    return result.items;
  } finally {
    await pdfDoc.destroy();
  }
};
