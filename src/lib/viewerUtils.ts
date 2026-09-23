// Type-only import: erased at build time so importing viewerUtils (for
// getPdfProxyUrl / formatFileSize / detectViewerSource) does NOT pull the heavy
// pdfjs library into non-viewer bundles (home, search, cards).
import type * as pdfjsLib from 'pdfjs-dist';
import { isFirebaseSite, isStaticSite, publicAssetUrl } from './runtimeConfig';

// Define source types
export type ViewerSourceType = 'pdf-url' | 'embed-html' | 'embed-url' | 'unknown';

export interface ViewerSource {
  type: ViewerSourceType;
  value: string;
  provider?: 'flippingbook' | 'iframe' | 'google-drive' | 'direct';
}

/**
 * Detects the type of content from a string input (URL or HTML code)
 */
export function detectViewerSource(input: string | null | undefined): ViewerSource {
  if (typeof input !== 'string') {
    return { type: 'unknown', value: '' };
  }
  const trimmed = input.trim();
  
  if (!trimmed) {
    return { type: 'unknown', value: '' };
  }

  if (trimmed.startsWith('firestore-pdf://')) {
    return { type: 'pdf-url', value: trimmed, provider: 'direct' };
  }

  // Firestore PDFs are reconstructed as object URLs in ViewerPage. Treat the
  // resulting browser Blob (and PDF data URLs used by recovery) as first-class
  // PDF sources instead of falling through to the invalid-content screen.
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:application/pdf')) {
    return { type: 'pdf-url', value: trimmed, provider: 'direct' };
  }

  // Check for HTML embed code
  if (trimmed.startsWith('<') || trimmed.includes('<script')) {
    let provider: ViewerSource['provider'] = 'iframe';
    if (trimmed.includes('fbo-embed') || trimmed.includes('flippingbook')) {
      provider = 'flippingbook';
    }
    return { type: 'embed-html', value: trimmed, provider };
  }

  // Check for local PDF paths (starting with /)
  if (trimmed.startsWith('/')) {
    if (trimmed.split('?')[0].toLowerCase().endsWith('.pdf')) {
      return { type: 'pdf-url', value: trimmed, provider: 'direct' };
    }
  }

  // Check for URLs
  if (trimmed.startsWith('http')) {
    // Check for Google Drive
    if (trimmed.includes('drive.google.com')) {
      return { type: 'embed-url', value: trimmed, provider: 'google-drive' };
    }
    
    // Check for FlippingBook hosted URLs
    if (trimmed.includes('flippingbook.com/view/')) {
       return { type: 'embed-url', value: trimmed, provider: 'flippingbook' };
    }

    // Check for direct PDF links
    if (trimmed.split('?')[0].toLowerCase().endsWith('.pdf')) {
      return { type: 'pdf-url', value: trimmed, provider: 'direct' };
    }

    // Default to embed URL if it's not a known PDF
    return { type: 'embed-url', value: trimmed, provider: 'iframe' };
  }

  return { type: 'unknown', value: trimmed };
}

/**
 * Normalizes FlippingBook embed code to be responsive and integrated
 */
export function normalizeFlippingBookEmbed(html: string): string {
  // If it's a link-replacement embed, we need to ensure it's not opening in lightbox
  let normalized = html;
  
  // Replace data-fbo-lightbox="yes" with "no"
  normalized = normalized.replace(/data-fbo-lightbox\s*=\s*["']yes["']/gi, 'data-fbo-lightbox="no"');
  
  // Force width to 100%
  if (normalized.includes('data-fbo-width')) {
    normalized = normalized.replace(/data-fbo-width\s*=\s*["'][^"']*["']/gi, 'data-fbo-width="100%"');
  } else {
    // Add it to the <a> tag if it's a flippingbook class
    normalized = normalized.replace(/class\s*=\s*["']fbo-embed["']/gi, 'class="fbo-embed" data-fbo-width="100%"');
  }

  // Ensure height is auto or handled by container
  normalized = normalized.replace(/data-fbo-height\s*=\s*["'][^"']*["']/gi, 'data-fbo-height="auto" data-fbo-ratio="16:9"');

  // Add styles to ensure responsiveness
  if (normalized.includes('<a')) {
    normalized = normalized.replace('<a', '<a style="width:100%; max-width:100%; display:block;"');
  }

  return normalized;
}

/**
 * Extracts only a navigable HTTP(S) URL from administrator-provided embed
 * markup. Scripts, event handlers and arbitrary HTML are never returned.
 */
export function extractSafeEmbedUrl(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(html, 'text/html');
  const candidate =
    document.querySelector('iframe[src]')?.getAttribute('src') ||
    document.querySelector('a[href]')?.getAttribute('href') ||
    '';
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Helper to get a proxy URL for PDFs to avoid CORS
 */
export function getPdfProxyUrl(url: string | null | undefined): string {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('firestore-pdf://')) return url;
  if (isStaticSite || isFirebaseSite) return publicAssetUrl(url);
  if (url.startsWith('/storage/') && url.toLowerCase().split('?')[0].endsWith('.pdf')) {
    return `/api/local-pdf?path=${encodeURIComponent(url.replace('/storage/', ''))}`;
  }
  if (url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:')) return url;
  return `/api/pdf-proxy?url=${encodeURIComponent(url)}`;
}

type DocumentSourceLike = {
  fileUrl?: string;
  externalUrl?: string;
  priority?: number;
  order?: number;
};

export function isPdfDocument(document: DocumentSourceLike): boolean {
  return detectViewerSource(document.fileUrl || document.externalUrl || '').type === 'pdf-url';
}

export function sortPdfDocumentsFirst<T extends DocumentSourceLike>(documents: T[]): T[] {
  return documents
    .map((document, index) => ({ document, index }))
    .sort((a, b) => {
      const pdfDifference = Number(isPdfDocument(b.document)) - Number(isPdfDocument(a.document));
      if (pdfDifference !== 0) return pdfDifference;

      const priorityDifference = (a.document.priority ?? 999) - (b.document.priority ?? 999);
      if (priorityDifference !== 0) return priorityDifference;

      const orderDifference = (a.document.order ?? 999) - (b.document.order ?? 999);
      if (orderDifference !== 0) return orderDifference;

      return a.index - b.index;
    })
    .map(({ document }) => document);
}

/**
 * Extracts text content from all pages of a PDF for searching
 * Optimized to process in chunks and yield to main thread
 */
export async function extractPdfText(pdf: pdfjsLib.PDFDocumentProxy): Promise<{ page: number, text: string }[]> {
  const result: { page: number, text: string }[] = new Array(pdf.numPages);
  const CHUNK_SIZE = 4;
  
  for (let i = 1; i <= pdf.numPages; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE - 1, pdf.numPages);
    const chunkPromises = [];
    
    for (let pageNum = i; pageNum <= end; pageNum++) {
      chunkPromises.push((async (pNum: number) => {
        try {
          const page = await pdf.getPage(pNum);
          const textContent = await page.getTextContent();
          const text = textContent.items
            .map((item: any) => typeof item.str === 'string' ? item.str : '')
            .join(' ');
          return { page: pNum, text };
        } catch (e) {
          console.warn(`Error extracting text from page ${pNum}`, e);
          return { page: pNum, text: '' };
        }
      })(pageNum));
    }
    
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.forEach(res => {
      result[res.page - 1] = res;
    });

    // Yield to UI
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return result;
}

/**
 * Formats bytes into a human readable string (KB, MB, GB)
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
