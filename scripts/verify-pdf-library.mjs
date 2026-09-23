import fs from 'node:fs/promises';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const projectRoot = process.cwd();
const distRoot = path.join(projectRoot, 'dist');
const documentsPath = path.join(distRoot, 'static-data', 'documents.json');
const baseUrl = String(
  process.env.PDF_VERIFY_BASE_URL || 'https://biblioteca-catalogos-chaide.web.app',
).replace(/\/+$/, '');

const documents = JSON.parse(await fs.readFile(documentsPath, 'utf8'));
const failures = [];
let checkedPages = 0;
let checkedSearchPages = 0;
const actualPageCounts = new Map();
const searchCorpora = new Map();
const normalizeSearch = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

async function fetchWithTransientRetry(url, init = {}, attempts = 3) {
  let lastResponse;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
      lastResponse = response;
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error('La solicitud de verificación no respondió.');
}

async function verifyPdfBytes(document, bytes) {
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
    actualPageCounts.set(document.id, pdf.numPages);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        if (!(viewport.width > 0 && viewport.height > 0)) {
          throw new Error('dimensiones inválidas');
        }
        checkedPages += 1;
      } catch (error) {
        failures.push({
          documentId: document.id,
          title: document.title,
          page: pageNumber,
          stage: 'page',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'pdf',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pdf?.destroy().catch(() => undefined);
  }
}

for (const document of documents) {
  const source = String(document.fileUrl || document.externalUrl || '');
  if (!source) {
    failures.push({ documentId: document.id, title: document.title, stage: 'source', error: 'sin URL' });
    continue;
  }

  try {
    if (source.startsWith('/')) {
      const pathname = new URL(source, 'https://local.invalid').pathname;
      const localFile = path.join(distRoot, ...pathname.split('/').filter(Boolean));
      await verifyPdfBytes(document, new Uint8Array(await fs.readFile(localFile)));
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await verifyPdfBytes(document, new Uint8Array(await response.arrayBuffer()));
    }
  } catch (error) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'file',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

for (const document of documents) {
  for (const field of ['id', 'title', 'description', 'category', 'fileUrl']) {
    if (!String(document[field] || '').trim()) {
      failures.push({
        documentId: document.id,
        title: document.title,
        stage: 'metadata',
        error: `campo obligatorio vacío: ${field}`,
      });
    }
  }

  const actualPages = actualPageCounts.get(document.id);
  if (actualPages && Number(document.pageCount) !== actualPages) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'metadata',
      error: `pageCount=${document.pageCount}; PDF=${actualPages}`,
    });
  }

  try {
    const indexPath = path.join(
      distRoot,
      'static-data',
      'search-index',
      `${document.id}.json`,
    );
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    const pages = Array.isArray(index.pages) ? index.pages : [];
    if (actualPages && pages.length !== actualPages) {
      throw new Error(`índice=${pages.length}; PDF=${actualPages}`);
    }
    const pageNumbers = new Set(pages.map((page) => Number(page.pageNumber)));
    for (let pageNumber = 1; pageNumber <= pages.length; pageNumber++) {
      if (!pageNumbers.has(pageNumber)) throw new Error(`falta la página ${pageNumber}`);
    }
    checkedSearchPages += pages.length;
    searchCorpora.set(document.id, normalizeSearch([
      document.title,
      document.description,
      document.category,
      ...(document.tags || []),
      ...pages.map((page) => page.text),
    ].join(' ')));
  } catch (error) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'search-index',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const searchQueries = {};
for (const query of ['colchones', 'sabanas', 'hotel', 'espumas', 'duvet']) {
  const normalizedQuery = normalizeSearch(query);
  const matches = documents.filter((document) =>
    searchCorpora.get(document.id)?.includes(normalizedQuery));
  searchQueries[query] = matches.length;
  if (matches.length === 0) {
    failures.push({
      stage: 'search-query',
      error: `la consulta "${query}" no devuelve catálogos`,
    });
  }
}

await Promise.all(documents.map(async (document) => {
  const source = String(document.fileUrl || document.externalUrl || '');
  const pdfUrl = source.startsWith('/') ? `${baseUrl}${source}` : source;
  if (!/^https?:\/\//i.test(pdfUrl)) return;

  try {
    const response = await fetchWithTransientRetry(pdfUrl, { headers: { Range: 'bytes=0-65535' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (source.startsWith('/') && response.status !== 206) {
      throw new Error(`se esperaba HTTP 206 y se recibió ${response.status}`);
    }
  } catch (error) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'range',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const route = `${baseUrl}/viewer/${encodeURIComponent(document.id)}?page=1`;
    const response = await fetch(route, { headers: { Accept: 'text/html' } });
    const html = await response.text();
    if (!response.ok || !html.includes('<div id="root">')) {
      throw new Error(`la recarga directa respondió HTTP ${response.status}`);
    }
  } catch (error) {
    failures.push({
      documentId: document.id,
      title: document.title,
      stage: 'viewer-route',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}));

const result = {
  ok: failures.length === 0,
  documents: documents.length,
  pages: checkedPages,
  searchPages: checkedSearchPages,
  searchQueries,
  production: baseUrl,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
