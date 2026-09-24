import express from "express";
import path from "path";
import multer from "multer";
import fs from "fs";
import zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import crypto from "crypto";
import "dotenv/config";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { catalogCategories } from "./src/lib/catalogCategories";
import { migrateCategoryHierarchy, categoryBranch } from "./src/lib/categoryHierarchy";

const pexecFile = promisify(execFile);

// Optional PDF linearization ("Fast Web View"). When qpdf is installed, this
// reorders the PDF so the first pages can stream/render before the whole file
// downloads. If qpdf is not present, it's a silent no-op (nothing breaks).
// Resolve the qpdf binary: explicit QPDF_PATH wins (robust against PATH not
// being refreshed after install), otherwise fall back to "qpdf" on PATH.
const QPDF_BIN = process.env.QPDF_PATH || "qpdf";
let qpdfAvailable: boolean | null = null;
async function hasQpdf(): Promise<boolean> {
  if (qpdfAvailable !== null) return qpdfAvailable;
  try {
    await pexecFile(QPDF_BIN, ["--version"], { timeout: 5000 });
    qpdfAvailable = true;
    console.log("[LINEARIZE] qpdf detected:", QPDF_BIN);
  } catch {
    qpdfAvailable = false;
  }
  return qpdfAvailable;
}
async function maybeLinearizePdf(filePath: string) {
  const tmp = `${filePath}.lin.pdf`;
  try {
    if (!(await hasQpdf())) return;
    try {
      await pexecFile(QPDF_BIN, ["--linearize", filePath, tmp], { timeout: 120000 });
    } catch (e: any) {
      // qpdf exits 3 on warnings but still writes a valid linearized file.
      if (!fs.existsSync(tmp)) throw e;
    }
    // Validate the result has a %PDF header before replacing the original.
    const fd = await fs.promises.open(tmp, "r");
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    await fd.close();
    if (buf.toString() !== "%PDF") throw new Error("linearized output invalid");
    await fs.promises.rename(tmp, filePath);
    console.log("[LINEARIZE] Fast Web View enabled:", path.basename(filePath));
  } catch {
    try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch { /* ignore */ }
  }
}

// Write endpoints are disabled unless ADMIN_TOKEN is configured. Production
// deployments must keep this value in the server environment.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";

// The session cookie is marked Secure (HTTPS-only) in production by default.
// For an INTERNAL server reachable only over plain HTTP, set COOKIE_SECURE=false
// so admin login works without HTTPS. Default: Secure when NODE_ENV=production.
const COOKIE_SECURE = typeof process.env.COOKIE_SECURE === "string"
  ? process.env.COOKIE_SECURE.toLowerCase() === "true"
  : process.env.NODE_ENV === "production";

function readCookie(req: any, name: string) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

function safeStringEqual(left: unknown, right: unknown) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyAdminPassword(password: string) {
  if (ADMIN_PASSWORD_HASH) {
    const [algorithm, saltHex, expectedHex] = ADMIN_PASSWORD_HASH.split("$");
    if (algorithm !== "scrypt" || !saltHex || !expectedHex) return false;
    try {
      const expected = Buffer.from(expectedHex, "hex");
      const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
      return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  return Boolean(ADMIN_PASSWORD) && safeStringEqual(password, ADMIN_PASSWORD);
}

function hasAdminAccess(req: any) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers["x-admin-token"] || readCookie(req, "chaide_admin");
  return safeStringEqual(provided, ADMIN_TOKEN);
}

function requireAdmin(req: any, res: any, next: any) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "Administración no configurada" });
  }
  if (hasAdminAccess(req)) return next();
  return res.status(401).json({ error: "No autorizado" });
}

// Blocks SSRF to loopback / private / link-local ranges for the PDF proxy.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "0.0.0.0", "::1", "::"].includes(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 private / loopback / link-local / metadata ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

// Utility: Move file securely
async function safeMoveFile(sourcePath: string, destinationPath: string) {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  console.log("[PDF MOVE START]", { sourcePath, destinationPath });
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error: any) {
    if (error.code !== "EXDEV") {
      console.error("[PDF MOVE ERROR]", { sourcePath, destinationPath, code: error.code, message: error.message, stack: error.stack });
      throw error;
    }
    // EXDEV is expected when crossing volumes, silently fall back to stream copying
    await pipeline(
      fs.createReadStream(sourcePath),
      fs.createWriteStream(destinationPath)
    );
    await fs.promises.unlink(sourcePath);
  }
  console.log("[PDF MOVE COMPLETE]", { destinationPath });
}

// Utility: Validate PDF
async function validatePdf(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0) throw new Error("El PDF final está vacío después de moverlo");
  
  const buffer = Buffer.alloc(4);
  const fd = await fs.promises.open(filePath, 'r');
  await fd.read(buffer, 0, 4, 0);
  await fd.close();
  
  if (buffer.toString() !== "%PDF") throw new Error("El archivo final no parece un PDF válido");
}

// Legacy GCS integration remains disabled. Backblaze B2 is accessed through
// its S3-compatible API and all credentials stay on the server.
let bucket: any = null;

const B2_ENDPOINT = String(process.env.B2_ENDPOINT || "").replace(/\/+$/, "");
const B2_REGION = String(process.env.B2_REGION || "");
const B2_BUCKET_NAME = String(process.env.B2_BUCKET_NAME || "");
const B2_KEY_ID = String(process.env.B2_KEY_ID || "");
const B2_APPLICATION_KEY = String(process.env.B2_APPLICATION_KEY || "");
const isB2Configured = Boolean(
  B2_ENDPOINT && B2_REGION && B2_BUCKET_NAME && B2_KEY_ID && B2_APPLICATION_KEY,
);

const b2Client = isB2Configured
  ? new S3Client({
      endpoint: B2_ENDPOINT,
      region: B2_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY,
      },
    })
  : null;

// Create directories robustly
const ROOT_DIR = process.cwd();
const SEED_DATA_DIR = path.join(ROOT_DIR, "data");
// Railway exposes the selected volume path automatically. DATA_DIR remains
// available as an explicit override for Docker and other hosting providers.
const DATA_DIR = path.resolve(
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  SEED_DATA_DIR,
);
const BASE_STORAGE = path.join(DATA_DIR, "uploads");
const LEGACY_STORAGE = path.join(ROOT_DIR, "storage");

function seedPersistentData() {
  if (DATA_DIR === SEED_DATA_DIR) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const entries = ["db.json", "uploads", "search-index"];

  for (const entry of entries) {
    const source = path.join(SEED_DATA_DIR, entry);
    const destination = path.join(DATA_DIR, entry);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.cpSync(source, destination, { recursive: true });
    console.log(`[DATA SEED] Copied ${entry} to persistent storage.`);
  }
}

seedPersistentData();

function isWithinStorageRoot(filePath: string) {
  return [BASE_STORAGE, LEGACY_STORAGE].some((root) => {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function getStorageCandidates(relativePath: string) {
  const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  return [path.join(BASE_STORAGE, normalizedPath), path.join(LEGACY_STORAGE, normalizedPath)]
    .filter(isWithinStorageRoot);
}

function resolveStoredFilePath(relativePath: string) {
  const candidates = getStorageCandidates(relativePath);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function normalizeStorageKey(value: string) {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep original */ }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function contentTypeForStorageKey(key: string) {
  const ext = path.extname(key).toLowerCase();
  const types: Record<string, string> = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  return types[ext] || "application/octet-stream";
}

function requireB2Storage() {
  if (!b2Client) {
    throw new Error("Backblaze B2 no está configurado en el servidor");
  }
  return b2Client;
}

async function uploadFileToB2(
  key: string,
  filePath: string,
  contentType?: string,
  onProgress?: (loaded: number, total: number) => void,
) {
  const client = requireB2Storage();
  const normalizedKey = normalizeStorageKey(key);
  if (!normalizedKey) throw new Error("Ruta de almacenamiento inválida");

  const uploadTask = new Upload({
    client,
    params: {
      Bucket: B2_BUCKET_NAME,
      Key: normalizedKey,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || contentTypeForStorageKey(normalizedKey),
      CacheControl: "public, max-age=31536000, immutable",
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    leavePartsOnError: false,
  });

  if (onProgress) {
    uploadTask.on("httpUploadProgress", (event) => {
      if (typeof event.loaded === "number") {
        onProgress(event.loaded, typeof event.total === "number" ? event.total : 0);
      }
    });
  }

  await uploadTask.done();
  console.log(`[B2 UPLOAD] ${normalizedKey}`);
}

async function headB2Object(key: string) {
  if (!b2Client) return null;
  const normalizedKey = normalizeStorageKey(key);
  if (!normalizedKey) return null;
  try {
    return await b2Client.send(new HeadObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: normalizedKey,
    }));
  } catch (error: any) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

async function readB2Object(key: string) {
  const client = requireB2Storage();
  const normalizedKey = normalizeStorageKey(key);
  if (!normalizedKey) throw new Error("Ruta de almacenamiento inválida");
  const object = await client.send(new GetObjectCommand({
    Bucket: B2_BUCKET_NAME,
    Key: normalizedKey,
  }));
  const body = object.Body as any;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error("Backblaze devolvió una respuesta no compatible");
  }
  return Buffer.from(await body.transformToByteArray());
}

async function deleteStoredAsset(assetUrl: unknown) {
  if (typeof assetUrl !== "string" || !assetUrl.startsWith("/storage/")) return;
  const key = normalizeStorageKey(assetUrl.slice("/storage/".length));
  if (!key) return;

  if (b2Client) {
    await b2Client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key }));
    console.log(`[B2 DELETE] ${key}`);
  }

  for (const localPath of getStorageCandidates(key)) {
    await fs.promises.unlink(localPath).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function streamB2Object(req: any, res: any, key: string) {
  const client = requireB2Storage();
  const normalizedKey = normalizeStorageKey(key);
  if (!normalizedKey) {
    res.status(400).json({ error: "Ruta de almacenamiento inválida" });
    return true;
  }

  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  if (range && !/^bytes=(\d*-\d*)$/.test(range)) {
    res.status(416).end();
    return true;
  }

  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: normalizedKey,
      ...(range ? { Range: range } : {}),
    }));

    const contentLength = Number(object.ContentLength || 0);
    res.status(object.ContentRange ? 206 : 200);
    res.setHeader("Content-Type", object.ContentType || contentTypeForStorageKey(normalizedKey));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", object.CacheControl || "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    if (contentLength > 0) res.setHeader("Content-Length", String(contentLength));
    if (object.ContentRange) res.setHeader("Content-Range", object.ContentRange);
    if (object.ETag) res.setHeader("ETag", object.ETag);

    const body = object.Body as any;
    if (!body || typeof body.pipe !== "function") {
      throw new Error("Backblaze devolvió una respuesta sin stream");
    }
    body.on("error", (error: unknown) => {
      console.error(`[B2 STREAM ERROR] ${normalizedKey}:`, error);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error as Error);
    });
    body.pipe(res);
    return true;
  } catch (error: any) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === "NoSuchKey") return false;
    if (status === 416 || error?.name === "InvalidRange") {
      res.status(416).end();
      return true;
    }
    throw error;
  }
}

const serverSearchIndexCache = new Map<string, any>();

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createSearchSnippet(originalText: string, normalizedQuery: string, matchIndex: number) {
  const contextChars = 90;
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(originalText.length, matchIndex + normalizedQuery.length + contextChars);
  const snippet = originalText.slice(start, end).trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < originalText.length ? "..." : ""}`;
}

// Pre-extracted page text is stored OUTSIDE db.json, one small file per
// document, so db.json stays light and every saveDb() write stays cheap.
const SEARCH_INDEX_DIR = path.join(DATA_DIR, "search-index");
type PersistedIndex = { stamp: string; pages: { pageNumber: number; text: string }[] };
function searchIndexPath(docId: string) {
  return path.join(SEARCH_INDEX_DIR, `${encodeURIComponent(docId)}.json`);
}
function readPersistedIndex(docId: string): PersistedIndex | null {
  try {
    const p = searchIndexPath(docId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function writePersistedIndex(docId: string, data: PersistedIndex) {
  try {
    fs.mkdirSync(SEARCH_INDEX_DIR, { recursive: true });
    fs.writeFileSync(searchIndexPath(docId), JSON.stringify(data));
  } catch (e) {
    console.warn("[SEARCH INDEX] write failed:", (e as any)?.message || e);
  }
}
function hasPersistedIndex(docId: string) {
  try {
    return fs.existsSync(searchIndexPath(docId));
  } catch {
    return false;
  }
}

async function buildServerPdfSearchIndex(doc: any) {
  const fileUrl = typeof doc?.fileUrl === "string" ? doc.fileUrl : "";
  if (!fileUrl.toLowerCase().split("?")[0].endsWith(".pdf")) return null;

  let cacheStamp = `${doc.id}:${doc.updatedAt || ""}:${fileUrl}`;
  let documentSource: any = null;

  let persistedFreshPages: { pageNumber: number; text: string }[] | null = null;

  if (fileUrl.startsWith("/storage/")) {
    const relativePath = fileUrl.replace("/storage/", "");
    const filePath = resolveStoredFilePath(relativePath);
    const hasValidLocalFile = fs.existsSync(filePath) && isPdfFileValid(filePath);
    if (hasValidLocalFile) {
      const stat = fs.statSync(filePath);
      cacheStamp = `${cacheStamp}:${stat.size}`;
    } else {
      const remote = await headB2Object(relativePath);
      if (!remote) return null;
      cacheStamp = `${cacheStamp}:${remote.ContentLength || 0}`;
    }

    // If we already extracted this exact file before (persisted to a per-doc
    // index file), build from stored text instead of re-parsing the PDF.
    const persisted = readPersistedIndex(doc.id);
    if (persisted && persisted.stamp === cacheStamp && Array.isArray(persisted.pages)) {
      persistedFreshPages = persisted.pages;
    } else {
      const pdfBytes = hasValidLocalFile
        ? fs.readFileSync(filePath)
        : await readB2Object(relativePath);
      documentSource = { data: new Uint8Array(pdfBytes), disableWorker: true };
    }
  } else if (fileUrl.startsWith("http")) {
    documentSource = { url: fileUrl, disableWorker: true };
  } else {
    return null;
  }

  const cached = serverSearchIndexCache.get(doc.id);
  if (cached?.stamp === cacheStamp) return cached.index;

  // Fast path: rebuild the in-memory index from persisted page text.
  if (persistedFreshPages) {
    const index: any = {
      catalogId: doc.id,
      title: doc.title,
      description: doc.description,
      coverUrl: withPublicDocumentAssets(doc).coverUrl,
      totalPages: doc.pageCount || persistedFreshPages.length,
      stamp: cacheStamp,
      pages: persistedFreshPages.map((p) => ({
        pageNumber: p.pageNumber,
        text: p.text,
        normalizedText: normalizeSearchText(p.text || ""),
      })),
    };
    serverSearchIndexCache.set(doc.id, { stamp: cacheStamp, index });
    return index;
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument(documentSource);
  const pdf = await loadingTask.promise;

  try {
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => item?.str || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      pages.push({
        pageNumber,
        text,
        normalizedText: normalizeSearchText(text),
      });
    }

    const index: any = {
      catalogId: doc.id,
      title: doc.title,
      description: doc.description,
      coverUrl: withPublicDocumentAssets(doc).coverUrl,
      totalPages: pdf.numPages,
      stamp: cacheStamp,
      pages,
    };

    serverSearchIndexCache.set(doc.id, { stamp: cacheStamp, index });
    return index;
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}

function isPdfFileValid(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) return false;

    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    return buffer.toString() === "%PDF";
  } catch {
    return false;
  }
}

const STORAGE_DIRS = [
  path.join(BASE_STORAGE, "pdfs"),
  path.join(BASE_STORAGE, "covers"),
  path.join(BASE_STORAGE, "banners"),
  path.join(BASE_STORAGE, "thumbnails"),
  path.join(BASE_STORAGE, "temp"),
  path.join(BASE_STORAGE, "categories"),
  DATA_DIR,
  path.join(BASE_STORAGE, "chunks")
];

const DEFAULT_CATEGORY_SLUGS = new Set<string>(catalogCategories.map((category) => category.slug));

function isDefaultCategory(category: any) {
  return typeof category?.slug === "string" && DEFAULT_CATEGORY_SLUGS.has(category.slug.toLowerCase());
}

function parseImageDataUrl(value: unknown) {
  if (typeof value !== "string") return null;

  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  return {
    contentType: match[1],
    base64: match[2],
  };
}

function withPublicDocumentAssets(doc: any) {
  const publicDoc = { ...doc };

  if (parseImageDataUrl(publicDoc.coverUrl)) {
    publicDoc.coverUrl = `/api/documents/${encodeURIComponent(publicDoc.id)}/cover`;
  }

  // Never ship the heavy pre-extracted page text to list/search clients; it is
  // only served on demand via /api/documents/:id/search-index.
  if ("searchIndex" in publicDoc) delete publicDoc.searchIndex;

  return publicDoc;
}

function createDefaultCategoryRecords() {
  const now = new Date().toISOString();

  return catalogCategories.map((category) => ({
    id: `catalog-${category.slug}`,
    name: category.label,
    slug: category.slug,
    description: category.description,
    icon: category.icon,
    imageUrl: "",
    order: category.order,
    active: true,
    keywords: [...category.keywords],
    createdAt: now,
    updatedAt: now,
  }));
}

function ensureDefaultCategories(db: any) {
  if (!db.categories) db.categories = [];

  let changed = false;
  const categoriesBySlug = new Map<string, any>(
    db.categories
      .filter((category: any) => typeof category?.slug === "string")
      .map((category: any) => [category.slug.toLowerCase(), category] as [string, any])
  );

  for (const defaultCategory of createDefaultCategoryRecords()) {
    const existing = categoriesBySlug.get(defaultCategory.slug);

    if (!existing) {
      db.categories.push(defaultCategory);
      changed = true;
      continue;
    }

    const merged = {
      ...defaultCategory,
      ...existing,
      id: existing.id || defaultCategory.id,
      slug: existing.slug || defaultCategory.slug,
      name: typeof existing.name === "string" ? existing.name : defaultCategory.name,
      description: typeof existing.description === "string" ? existing.description : defaultCategory.description,
      icon: typeof existing.icon === "string" ? existing.icon : defaultCategory.icon,
      imageUrl: typeof existing.imageUrl === "string" ? existing.imageUrl : defaultCategory.imageUrl,
      order: typeof existing.order === "number" ? existing.order : defaultCategory.order,
      active: typeof existing.active === "boolean" ? existing.active : defaultCategory.active,
      keywords: Array.isArray(existing.keywords) && existing.keywords.length > 0
        ? existing.keywords
        : defaultCategory.keywords,
      createdAt: existing.createdAt || defaultCategory.createdAt,
      updatedAt: existing.updatedAt || defaultCategory.updatedAt,
    };

    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      Object.assign(existing, merged);
      changed = true;
    }
  }

  return changed;
}

const DEFAULT_PROMOTIONAL_BANNER_WEB = "/anuncio%20web%20(3640x900)-01.png";
const DEFAULT_PROMOTIONAL_BANNER_MOBILE = "/anuncio%20web%20(1700x1900).png";
const REPLACED_PROMOTIONAL_BANNER_URLS = new Set([
  "/storage/banners/banner-1781800467049-ns7paj.png",
  "/storage/banners/banner-1781802763314-b7i6gz.png",
]);

function buildDefaultPromotionalBanner(_db: any) {
  const now = new Date().toISOString();

  return {
    imageUrl: DEFAULT_PROMOTIONAL_BANNER_WEB,
    mobileImageUrl: DEFAULT_PROMOTIONAL_BANNER_MOBILE,
    mobileIsActive: true,
    altText: "Anuncio promocional Chaide",
    targetUrl: "https://www.chaide.com/",
    isActive: true,
    updatedAt: now,
  };
}

function normalizePromotionalBanner(input: any, fallback: any) {
  const imageUrl = typeof input?.imageUrl === "string" ? input.imageUrl : fallback.imageUrl;
  const hasMobileFlag = typeof input?.mobileIsActive === "boolean";
  const storedMobileImage = typeof input?.mobileImageUrl === "string" ? input.mobileImageUrl : "";
  const mobileImageUrl = storedMobileImage || (!hasMobileFlag ? imageUrl || fallback.mobileImageUrl || "" : "");

  return {
    imageUrl,
    mobileImageUrl,
    mobileIsActive: hasMobileFlag ? input.mobileIsActive : Boolean(mobileImageUrl),
    altText: typeof input?.altText === "string" && input.altText.trim()
      ? input.altText
      : fallback.altText,
    targetUrl: typeof input?.targetUrl === "string" ? input.targetUrl : fallback.targetUrl,
    isActive: typeof input?.isActive === "boolean" ? input.isActive : fallback.isActive,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : fallback.updatedAt,
  };
}

function ensurePromotionalBannerConfig(db: any) {
  const fallback = buildDefaultPromotionalBanner(db);
  const storedBanner = db.promotionalBanner && typeof db.promotionalBanner === "object"
    ? { ...db.promotionalBanner }
    : db.promotionalBanner;
  if (storedBanner && REPLACED_PROMOTIONAL_BANNER_URLS.has(storedBanner.imageUrl)) {
    storedBanner.imageUrl = DEFAULT_PROMOTIONAL_BANNER_WEB;
  }
  if (storedBanner && REPLACED_PROMOTIONAL_BANNER_URLS.has(storedBanner.mobileImageUrl)) {
    storedBanner.mobileImageUrl = DEFAULT_PROMOTIONAL_BANNER_MOBILE;
  }
  const nextBanner = normalizePromotionalBanner(storedBanner, fallback);
  const changed = JSON.stringify(db.promotionalBanner || null) !== JSON.stringify(nextBanner);
  db.promotionalBanner = nextBanner;
  return changed;
}

STORAGE_DIRS.forEach(dirPath => {
  try {
    if (!fs.existsSync(dirPath)) {
      console.log(`Creating directory: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
    }
    // Check if writable
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch (err) {
    console.warn(`Warning: Directory ${dirPath} might not be writable or createable. Deployments in read-only environments may fail if this is required.`);
  }
});

const upload = multer({
  dest: path.join(BASE_STORAGE, "temp/"),
  limits: {
    // Uploads arrive as 1 MB chunks (so each part is tiny), but allow large
    // single-shot uploads too. Caps the whole catalog at 500 MB.
    fileSize: 500 * 1024 * 1024, // 500MB
    fieldSize: 10 * 1024 * 1024, // 10MB
    fields: 20, // max fields
    files: 20 // max files
  }
});

const UPLOAD_SESSION_ID_PATTERN = /^upload-[a-zA-Z0-9-]+$/;
const ABANDONED_UPLOAD_MAX_AGE_MS = 30 * 60 * 1000;
type UploadSessionProgress = {
  phase: "preparing" | "uploading" | "verifying" | "complete" | "error";
  loaded: number;
  total: number;
  updatedAt: number;
};
const uploadSessionProgress = new Map<string, UploadSessionProgress>();

function setUploadSessionProgress(uploadId: string, phase: UploadSessionProgress["phase"], loaded: number, total: number) {
  uploadSessionProgress.set(uploadId, { phase, loaded, total, updatedAt: Date.now() });
  if (uploadSessionProgress.size > 200) {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, progress] of uploadSessionProgress) {
      if (progress.updatedAt < cutoff) uploadSessionProgress.delete(id);
    }
  }
}

async function removeIncompleteUploadSession(uploadId: string, removeRemote = false) {
  if (!UPLOAD_SESSION_ID_PATTERN.test(uploadId)) return false;
  uploadSessionProgress.delete(uploadId);
  const tempRoot = path.resolve(BASE_STORAGE, "temp-chunks");
  const sessionDir = path.resolve(tempRoot, uploadId);
  if (!sessionDir.startsWith(`${tempRoot}${path.sep}`)) return false;
  await fs.promises.rm(sessionDir, { recursive: true, force: true });
  if (removeRemote) {
    await deleteStoredAsset(`/storage/pdfs/${uploadId}.pdf`).catch(() => undefined);
  }
  return true;
}

async function cleanupAbandonedUploadSessions() {
  const tempRoot = path.join(BASE_STORAGE, "temp-chunks");
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !UPLOAD_SESSION_ID_PATTERN.test(entry.name)) continue;
    const stats = await fs.promises.stat(path.join(tempRoot, entry.name)).catch(() => null);
    if (!stats || now - stats.mtimeMs < ABANDONED_UPLOAD_MAX_AGE_MS) continue;
    await removeIncompleteUploadSession(entry.name);
    console.log(`[UPLOAD CLEANUP] Removed abandoned session ${entry.name}`);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Set timeouts for large uploads
  app.use((req, res, next) => {
    // 10 minutes timeout for requests
    req.setTimeout(600000);
    res.setTimeout(600000);
    next();
  });

  // Baseline browser protections. CSP is intentionally handled by the hosting
  // layer because the app loads Firebase and optional external catalogue embeds.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  // CORS
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    const configuredOrigins = String(process.env.CORS_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    let allowedOrigin = "";
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost === forwardedHost || configuredOrigins.includes(origin)) allowedOrigin = origin;
      } catch { /* malformed origins are rejected below */ }
    }
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
    if (req.method === "OPTIONS") {
      return origin && !allowedOrigin ? res.sendStatus(403) : res.sendStatus(204);
    }
    next();
  });

  // Lightweight gzip for JSON API responses only (PDFs/binary streams are left
  // untouched). Avoids pulling in an extra dependency while shrinking the
  // documents/search/categories payloads notably.
  app.use((req, res, next) => {
    const accepts = String(req.headers["accept-encoding"] || "");
    if (!/\bgzip\b/.test(accepts)) return next();
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      try {
        const raw = Buffer.from(JSON.stringify(body ?? null));
        if (raw.length < 1024) return originalJson(body);
        const gzipped = zlib.gzipSync(raw);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Content-Length", String(gzipped.length));
        return res.end(gzipped);
      } catch {
        return originalJson(body);
      }
    };
    next();
  });

  // Serve pdf.js character maps locally instead of from a third-party CDN.
  const cMapsDir = path.join(ROOT_DIR, "node_modules", "pdfjs-dist", "cmaps");
  if (fs.existsSync(cMapsDir)) {
    app.use("/cmaps", express.static(cMapsDir, { maxAge: "1y", immutable: true }));
  }

  // 1. Core API routes (No large body parsing needed yet)
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  app.get("/api/storage/status", requireAdmin, async (_req, res) => {
    if (!b2Client) {
      return res.status(503).json({
        provider: "backblaze-b2",
        configured: false,
        connected: false,
      });
    }
    try {
      await b2Client.send(new HeadBucketCommand({ Bucket: B2_BUCKET_NAME }));
      return res.json({
        provider: "backblaze-b2",
        configured: true,
        connected: true,
        bucket: B2_BUCKET_NAME,
        endpoint: B2_ENDPOINT,
        region: B2_REGION,
      });
    } catch (error: any) {
      console.error("[B2 STATUS]", error?.name || error?.message || error);
      return res.status(502).json({
        provider: "backblaze-b2",
        configured: true,
        connected: false,
        error: "No se pudo acceder al bucket configurado",
      });
    }
  });

  app.get("/api/local-pdf", async (req, res) => {
    try {
      const requestedPath = req.query.path;
      if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        return res.status(400).json({ error: "PDF path is required" });
      }

      const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
      const normalizedForCheck = normalizedPath.replace(/\\/g, "/");
      if (
        path.isAbsolute(normalizedPath) ||
        normalizedForCheck.includes("../") ||
        !normalizedForCheck.startsWith("pdfs/") ||
        !normalizedForCheck.toLowerCase().endsWith(".pdf")
      ) {
        return res.status(400).json({ error: "Invalid PDF path" });
      }

      const filePath = resolveStoredFilePath(normalizedPath);
      if (!fs.existsSync(filePath) || !isPdfFileValid(filePath)) {
        const servedFromB2 = b2Client
          ? await streamB2Object(req, res, normalizedForCheck)
          : false;
        if (servedFromB2) return;
        return res.status(404).json({ error: "PDF not found" });
      }

      const fileSize = fs.statSync(filePath).size;
      const range = req.headers.range;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");
      // Stored PDFs are content-addressed by document id (immutable), so allow
      // long-lived caching. This prevents re-downloading the whole file every
      // time the viewer is reopened.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

      if (range) {
        const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-");
        let start: number;
        let end: number;

        if (startRaw === "") {
          const suffixLength = parseInt(endRaw, 10);
          start = Number.isFinite(suffixLength) ? Math.max(fileSize - suffixLength, 0) : 0;
          end = fileSize - 1;
        } else {
          start = parseInt(startRaw, 10);
          end = endRaw ? parseInt(endRaw, 10) : fileSize - 1;
        }

        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
          res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
          return res.end();
        }

        end = Math.min(end, fileSize - 1);
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": chunkSize,
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }

      res.writeHead(200, {
        "Content-Length": fileSize,
      });
      return fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error("Error serving local PDF:", err);
      return res.status(500).json({ error: "Internal PDF serving error" });
    }
  });

  // 2. Large File Upload Routes (Using chunked uploads for iframe stability)
  app.post("/api/documents/upload-chunk", requireAdmin, upload.single("chunk"), async (req, res) => {
    try {
      const { uploadId, chunkIndex, totalChunks, fileName, documentsInfo } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "Chunk no recibido." });
      }

      const normalizedChunkIndex = Number(chunkIndex);
      const normalizedTotalChunks = Number(totalChunks);
      if (
        !UPLOAD_SESSION_ID_PATTERN.test(String(uploadId || "")) ||
        !Number.isInteger(normalizedChunkIndex) ||
        !Number.isInteger(normalizedTotalChunks) ||
        normalizedTotalChunks < 1 ||
        normalizedTotalChunks > 1000 ||
        normalizedChunkIndex < 0 ||
        normalizedChunkIndex >= normalizedTotalChunks
      ) {
        await fs.promises.unlink(file.path).catch(() => undefined);
        return res.status(400).json({ error: "Sesión de carga inválida." });
      }

      const tempDir = path.join(BASE_STORAGE, "temp-chunks", uploadId);
      await fs.promises.mkdir(tempDir, { recursive: true });

      const chunkPath = path.join(tempDir, `chunk-${chunkIndex}`);
      await fs.promises.rename(file.path, chunkPath);

      if (normalizedChunkIndex === normalizedTotalChunks - 1) {
        // This is the last chunk, reassemble the file
        setUploadSessionProgress(String(uploadId), "preparing", 0, 0);
        const ext = ".pdf";
        const relativeFinalPath = `pdfs/${uploadId}${ext}`;
        const finalPath = path.join(BASE_STORAGE, relativeFinalPath);
        
        await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
        
        const writeStream = fs.createWriteStream(finalPath);
        let totalSize = 0;
        
        for (let i = 0; i < normalizedTotalChunks; i++) {
          const cp = path.join(tempDir, `chunk-${i}`);
          const data = await fs.promises.readFile(cp);
          writeStream.write(data);
          totalSize += data.length;
          await fs.promises.unlink(cp);
        }
        writeStream.end();
        
        await new Promise<void>((resolve) => writeStream.on("finish", () => resolve()));
        await fs.promises.rmdir(tempDir);
        await validatePdf(finalPath);
        await maybeLinearizePdf(finalPath);
        const uploadedSize = (await fs.promises.stat(finalPath)).size;
        setUploadSessionProgress(String(uploadId), "uploading", 0, uploadedSize);
        await uploadFileToB2(relativeFinalPath, finalPath, "application/pdf", (loaded) => {
          setUploadSessionProgress(String(uploadId), "uploading", Math.min(loaded, uploadedSize), uploadedSize);
        });
        setUploadSessionProgress(String(uploadId), "verifying", uploadedSize, uploadedSize);

        const info = documentsInfo ? JSON.parse(documentsInfo)[0] : {};
        const newDoc = {
          id: uploadId,
          title: info.title || fileName.replace(".pdf", ""),
          description: info.description || "",
          category: info.category || "Sin categoría",
          pageCount: 1,
          coverUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
          fileUrl: `/storage/${relativeFinalPath}`,
          tags: info.tags || [],
          status: "processing",
          sourceType: "upload",
          publicationType: info.publicationType === "technical-sheet" ? "technical-sheet" : "catalog",
          visibility: info.visibility || "public",
          fileSize: uploadedSize,
          storageProvider: "backblaze-b2",
          isActive: true,
          updatedAt: new Date().toISOString()
        };

        const db = getDb();
        db.documents.unshift(newDoc);
        saveDb(db);
        setUploadSessionProgress(String(uploadId), "complete", uploadedSize, uploadedSize);

        // Pre-extract searchable text in the background (non-blocking).
        ensureSearchIndex(newDoc)
          .catch(() => undefined)
          .finally(() => fs.promises.unlink(finalPath).catch(() => undefined));

        return res.json([newDoc]);
      } else {
        return res.json({ success: true, chunkIndex });
      }
    } catch (e: any) {
      const uploadId = String(req.body?.uploadId || "");
      if (UPLOAD_SESSION_ID_PATTERN.test(uploadId)) {
        const previous = uploadSessionProgress.get(uploadId);
        setUploadSessionProgress(uploadId, "error", previous?.loaded || 0, previous?.total || 0);
      }
      console.error("[CHUNK UPLOAD ERROR]", e);
      res.status(500).json({ error: "Error procesando el fragmento", details: e.message });
    }
  });

  app.post("/api/documents/upload", requireAdmin, upload.array("pdfs"), async (req, res) => {
    try {
      const files = (req.files as Express.Multer.File[]) || [];
      const payloadInfo = req.body && req.body.documentsInfo ? JSON.parse(req.body.documentsInfo) : [];
      
      if (files.length === 0) {
        return res.status(400).json({ error: "No se recibieron archivos." });
      }

      console.log(`[UPLOAD] Processing ${files.length} files`);
      const db = getDb();
      const newDocs = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const info = payloadInfo[i] || {};
        const docId = `doc-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const ext = path.extname(file.originalname) || ".pdf";
        const relativeFinalPath = `pdfs/${docId}${ext}`;
        const finalPath = path.join(BASE_STORAGE, relativeFinalPath);

        await safeMoveFile(file.path, finalPath);
        await validatePdf(finalPath);
        await maybeLinearizePdf(finalPath);
        await uploadFileToB2(relativeFinalPath, finalPath, "application/pdf");
        const uploadedSize = (await fs.promises.stat(finalPath)).size;

        const newDoc = {
          id: docId,
          title: info.title || file.originalname.replace(".pdf", ""),
          description: info.description || "",
          category: info.category || "Sin categoría",
          pageCount: 1,
          coverUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
          fileUrl: `/storage/${relativeFinalPath}`,
          tags: info.tags || [],
          status: "processing",
          sourceType: "upload",
          publicationType: info.publicationType === "technical-sheet" ? "technical-sheet" : "catalog",
          visibility: info.visibility || "public",
          fileSize: uploadedSize,
          storageProvider: "backblaze-b2",
          isActive: true,
          updatedAt: new Date().toISOString()
        };

        db.documents.unshift(newDoc);
        newDocs.push(newDoc);

        ensureSearchIndex(newDoc)
          .catch(() => undefined)
          .finally(() => fs.promises.unlink(finalPath).catch(() => undefined));
      }

      saveDb(db);
      res.json(newDocs);
    } catch (e: any) {
      console.error("[UPLOAD CRITICAL ERROR]", e);
      res.status(500).json({ 
        error: "Error interno procesando la carga", 
        details: e.message 
      });
    }
  });

  // 3. Global Body Parsers for other routes
  app.use(express.json({ limit: "30mb" }));
  app.use(express.urlencoded({ extended: true, limit: "30mb" }));

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/auth/login", (req, res) => {
    if (!ADMIN_TOKEN || !ADMIN_USERNAME || (!ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD)) {
      return res.status(503).json({ error: "Administración no configurada" });
    }

    const attemptKey = String(req.ip || req.socket.remoteAddress || "unknown");
    const now = Date.now();
    const previousAttempt = loginAttempts.get(attemptKey);
    const attempt = previousAttempt && previousAttempt.resetAt > now
      ? previousAttempt
      : { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (attempt.count >= 10) {
      res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Demasiados intentos. Intenta nuevamente más tarde." });
    }

    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!safeStringEqual(username, ADMIN_USERNAME.toLowerCase()) || !verifyAdminPassword(password)) {
      attempt.count += 1;
      loginAttempts.set(attemptKey, attempt);
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    loginAttempts.delete(attemptKey);

    res.setHeader(
      "Set-Cookie",
      `chaide_admin=${encodeURIComponent(ADMIN_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${COOKIE_SECURE ? "; Secure" : ""}`,
    );
    return res.json({
      user: {
        id: "admin",
        email: username.includes("@") ? username : `${username}@chaide.local`,
        name: "Administrador Chaide",
        role: "admin",
      },
    });
  });

  app.get("/api/auth/session", (req, res) => {
    const authenticated = hasAdminAccess(req);
    return res.json({ authenticated });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      `chaide_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`,
    );
    return res.json({ ok: true });
  });

  // Debug logger
  const logFile = path.join(DATA_DIR, "logs.txt");
  app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
      const logEntry = `[API] ${req.method} ${req.url} - ${new Date().toISOString()}\n`;
      console.log(logEntry.trim());
      try {
        fs.appendFileSync(logFile, logEntry);
      } catch (e) {}
    }
    next();
  });

  // Database persistent storage using fs
  let memoryDb: any = { documents: [], categories: [], promotionalBanner: null };
  const dbPath = path.join(DATA_DIR, "db.json");
  
  const loadFromFirestore = async () => {
    try {
      if (fs.existsSync(dbPath)) {
         const data = fs.readFileSync(dbPath, "utf-8");
         memoryDb = JSON.parse(data);
         if (!memoryDb.documents) memoryDb.documents = [];
         if (!memoryDb.categories) memoryDb.categories = [];
         if (!("promotionalBanner" in memoryDb)) memoryDb.promotionalBanner = null;
         console.log(`[DB LOAD] Loaded from local db.json`);
      } else {
        // Seed initial mock data if empty
        const seedData = [
          {
            id: "doc-SABANAS",
            title: "Sábanas Sunset",
            description: "Colección de Sábanas Sunset: suavidad y elegancia para tu descanso.",
            category: "Catálogo",
            pageCount: 5,
            coverUrl: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&q=80&w=800",
            fileUrl: "https://pdfobject.com/pdf/sample-3pp.pdf",
            tags: ["Textiles", "Sábanas", "Novedades"],
            isFeatured: true,
            status: "ready",
            sourceType: "upload"
          }
        ];
        memoryDb = { documents: seedData, categories: [], promotionalBanner: null };
      }
    } catch(e) {
      console.error("[DB LOAD INITIAL]", e);
    }
  };
  await loadFromFirestore();

  const getDb = () => memoryDb;
  const saveDb = (data: any) => {
     memoryDb = data;
     try {
       fs.mkdirSync(path.dirname(dbPath), { recursive: true });
       fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
     } catch (e) {
       console.error("Local sync error:", e);
     }
  };

  if (!memoryDb.categoryHierarchyVersion) {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, `${dbPath}.before-category-hierarchy-${Date.now()}.bak`);
    if (migrateCategoryHierarchy(memoryDb)) saveDb(memoryDb);
  }
  if (ensureDefaultCategories(memoryDb)) {
    saveDb(memoryDb);
    console.log("[DB REPAIR] Added default catalog categories.");
  }

  if (ensurePromotionalBannerConfig(memoryDb)) {
    saveDb(memoryDb);
    console.log("[DB REPAIR] Added promotional banner config.");
  }

  // One-time migration: move any legacy searchIndex that lives inside db.json
  // out into per-doc index files, then drop it from db.json to keep it small.
  const migrateLegacyIndexes = () => {
    const liveDb = getDb();
    let changed = false;
    for (const d of liveDb.documents || []) {
      if (d.searchIndex && Array.isArray(d.searchIndex.pages)) {
        if (!hasPersistedIndex(d.id)) {
          writePersistedIndex(d.id, { stamp: d.searchIndex.stamp || "", pages: d.searchIndex.pages });
        }
        delete d.searchIndex;
        changed = true;
      }
    }
    if (changed) {
      saveDb(liveDb);
      console.log("[SEARCH INDEX] Migrated legacy in-db indexes to per-doc files.");
    }
  };
  migrateLegacyIndexes();

  // One-time migration: externalize legacy base64 covers into Backblaze B2 so
  // db.json stays small and all managed media uses the same storage provider.
  const migrateBase64Covers = async () => {
    const liveDb = getDb();
    let changed = false;
    const coversDir = path.join(BASE_STORAGE, "covers");
    for (const d of liveDb.documents || []) {
      const parsed = parseImageDataUrl(d.coverUrl);
      if (!parsed) continue;
      try {
        const extMap: Record<string, string> = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/jpg": ".jpg",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "image/svg+xml": ".svg",
        };
        const ext = extMap[parsed.contentType] || ".img";
        fs.mkdirSync(coversDir, { recursive: true });
        const fileName = `${encodeURIComponent(d.id)}${ext}`;
        const localPath = path.join(coversDir, fileName);
        fs.writeFileSync(localPath, Buffer.from(parsed.base64, "base64"));
        await uploadFileToB2(`covers/${fileName}`, localPath, parsed.contentType);
        await fs.promises.unlink(localPath).catch(() => undefined);
        d.coverUrl = `/storage/covers/${fileName}`;
        changed = true;
      } catch (e: any) {
        console.warn(`[COVERS] Could not externalize cover for ${d.id}: ${e?.message || e}`);
      }
    }
    if (changed) {
      saveDb(liveDb);
      console.log("[COVERS] Migrated base64 covers to Backblaze B2; db.json slimmed down.");
    }
  };
  await migrateBase64Covers();

  // Build (if needed) the server-side search index for a document and persist
  // the extracted page text to a per-doc file. This means /api/search and the
  // viewer never have to re-parse the whole PDF on every query / open.
  const ensureSearchIndex = async (doc: any, persist = true) => {
    const index = await buildServerPdfSearchIndex(doc);
    if (!index) return null;
    if (persist && index.stamp) {
      const existing = readPersistedIndex(doc.id);
      if (existing?.stamp !== index.stamp) {
        writePersistedIndex(doc.id, {
          stamp: index.stamp,
          pages: index.pages.map((p: any) => ({ pageNumber: p.pageNumber, text: p.text })),
        });
      }
      // Keep an accurate page count in db (small field) for list/search views.
      const liveDb = getDb();
      const target = liveDb.documents.find((d: any) => d.id === doc.id);
      if (target && (!target.pageCount || target.pageCount < 2) && index.totalPages) {
        target.pageCount = index.totalPages;
        saveDb(liveDb);
      }
    }
    return index;
  };

  // Backfill search indexes for existing catalogs without blocking startup.
  const backfillSearchIndexes = async () => {
    const liveDb = getDb();
    const pending = (liveDb.documents || []).filter((d: any) => {
      const fileUrl = typeof d.fileUrl === "string" ? d.fileUrl : "";
      const isLocalPdf = fileUrl.startsWith("/storage/") && fileUrl.toLowerCase().endsWith(".pdf");
      return !d.isDeleted && isLocalPdf && !hasPersistedIndex(d.id);
    });
    if (pending.length === 0) return;
    console.log(`[SEARCH INDEX] Backfilling ${pending.length} document(s)...`);
    for (const doc of pending) {
      try {
        // Linearize first (no-op if qpdf is absent) so the persisted stamp
        // matches the optimized file and we only do this once per document.
        const filePath = resolveStoredFilePath(doc.fileUrl.replace("/storage/", ""));
        if (fs.existsSync(filePath)) await maybeLinearizePdf(filePath);
        await ensureSearchIndex(doc);
        await new Promise((r) => setTimeout(r, 250));
      } catch (e: any) {
        console.warn(`[SEARCH INDEX] Skipped ${doc.title}: ${e?.message || e}`);
      }
    }
    console.log("[SEARCH INDEX] Backfill complete.");
  };

  // One-time linearization of catalogs that were uploaded before qpdf was
  // available. Backfill skips docs that already have an index, so this handles
  // them: linearize the file, mark it, then refresh the persisted index so its
  // stamp matches the (now reordered) file.
  const linearizeExistingPdfs = async () => {
    if (!(await hasQpdf())) return;
    const liveDb = getDb();
    const pending = (liveDb.documents || []).filter((d: any) => {
      const fileUrl = typeof d.fileUrl === "string" ? d.fileUrl : "";
      const isLocalPdf = fileUrl.startsWith("/storage/") && fileUrl.toLowerCase().endsWith(".pdf");
      return !d.isDeleted && isLocalPdf && !d.linearized;
    });
    if (pending.length === 0) return;
    console.log(`[LINEARIZE] Optimizing ${pending.length} existing catalog(s) for Fast Web View...`);
    for (const doc of pending) {
      try {
        const filePath = resolveStoredFilePath(doc.fileUrl.replace("/storage/", ""));
        if (!fs.existsSync(filePath)) continue;
        await maybeLinearizePdf(filePath);
        // Mark as done and refresh the index (file mtime/size changed).
        const live = getDb();
        const target = live.documents.find((x: any) => x.id === doc.id);
        if (target) {
          target.linearized = true;
          saveDb(live);
        }
        await ensureSearchIndex(doc); // re-stamp index to the linearized file
        await new Promise((r) => setTimeout(r, 200));
      } catch (e: any) {
        console.warn(`[LINEARIZE] Skipped ${doc.title}: ${e?.message || e}`);
      }
    }
    console.log("[LINEARIZE] Existing catalogs optimized.");
  };

  // PDF Proxy from GCS
  app.get("/api/proxy/pdf/:fileName", async (req, res) => {
    if (!bucket) return res.status(500).json({ error: "GCS not configured" });

    const fileName = req.params.fileName;
    const storageKey = `pdfs/${fileName}`;
    const file = bucket.file(storageKey);

    try {
        const [exists] = await file.exists();
        if (!exists) {
            console.error(`File does not exist in GCS: ${storageKey}`);
            return res.status(404).json({ error: "File not found" });
        }
        
        const [metadata] = await file.getMetadata();
        const fileSize = Number(metadata.size);
        const range = req.headers.range;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize) {
                res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
                return res.end();
            }

            const chunkSize = end - start + 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": "application/pdf",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
            });
            const stream = file.createReadStream({ start, end });
            stream.on('error', (err) => {
                console.error("Stream error during range request:", err);
                if (!res.headersSent) res.status(500).json({ error: "Stream error" });
            });
            stream.pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": "application/pdf",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
            });
            const stream = file.createReadStream();
            stream.on('error', (err) => {
                console.error("Stream error:", err);
                if (!res.headersSent) res.status(500).json({ error: "Stream error" });
            });
            stream.pipe(res);
        }
    } catch (err) {
        console.error(`Failed to proxy GCS file ${storageKey}:`, err);
        if (!res.headersSent) res.status(500).json({ error: "Failed to proxy file" });
    }
  });

  // Existing local files remain readable during migration. New uploads are
  // stored in B2 and transparently streamed through the same /storage URLs.
  app.use("/storage", express.static(BASE_STORAGE, {
    maxAge: '1y',
    immutable: true,
    index: false
  }));
  app.use("/storage", express.static(LEGACY_STORAGE, {
    maxAge: '1y',
    immutable: true,
    index: false
  }));

  app.use("/storage", async (req, res, next) => {
    if (!b2Client || (req.method !== "GET" && req.method !== "HEAD")) return next();
    const key = normalizeStorageKey(req.path);
    if (!key) return res.status(400).json({ error: "Ruta de almacenamiento inválida" });

    try {
      if (req.method === "HEAD") {
        const object = await b2Client.send(new HeadObjectCommand({
          Bucket: B2_BUCKET_NAME,
          Key: key,
        }));
        if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
        if (object.ContentLength !== undefined) res.setHeader("Content-Length", String(object.ContentLength));
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", object.CacheControl || "public, max-age=31536000, immutable");
        return res.status(200).end();
      }

      const served = await streamB2Object(req, res, key);
      if (!served) return next();
    } catch (error) {
      console.error(`[B2 SERVE ERROR] ${key}:`, error);
      if (!res.headersSent) return res.status(502).json({ error: "No se pudo leer el archivo desde Backblaze" });
    }
  });

  app.get("/api/documents/upload-session/:uploadId/progress", requireAdmin, (req, res) => {
    const uploadId = String(req.params.uploadId || "");
    if (!UPLOAD_SESSION_ID_PATTERN.test(uploadId)) {
      return res.status(400).json({ error: "Sesión de carga inválida." });
    }
    const progress = uploadSessionProgress.get(uploadId);
    return res.json(progress
      ? { phase: progress.phase, loaded: progress.loaded, total: progress.total }
      : { phase: "preparing", loaded: 0, total: 0 });
  });

  app.delete("/api/documents/upload-session/:uploadId", requireAdmin, async (req, res) => {
    const uploadId = String(req.params.uploadId || "");
    if (!UPLOAD_SESSION_ID_PATTERN.test(uploadId)) {
      return res.status(400).json({ error: "Sesión de carga inválida." });
    }

    const db = getDb();
    const committed = db.documents.some((document: any) => document.id === uploadId && !document.isDeleted);
    if (committed) {
      return res.json({ success: true, committed: true });
    }

    await removeIncompleteUploadSession(uploadId, true);
    return res.json({ success: true, committed: false });
  });

  // Removed duplicate health route

  app.post("/api/documents/presentation", requireAdmin, (req, res) => {
    const db = getDb();
    const current = db.documents.filter((d: any) => !d.isDeleted);
    const { ids, featuredId } = req.body;
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length ||
        current.some((d: any) => !ids.includes(d.id))) {
      return res.status(409).json({ error: 'La biblioteca cambió. Actualiza la lista e inténtalo de nuevo.' });
    }
    if (featuredId !== null && !current.some((d: any) => d.id === featuredId && d.status === 'ready' && d.isActive !== false && d.visibility !== 'private')) {
      return res.status(400).json({ error: 'El principal debe ser un documento publicado.' });
    }
    const next = { ...db, documents: db.documents.map((d: any) => d.isDeleted ? d :
      { ...d, order: ids.indexOf(d.id), isFeatured: d.id === featuredId }) };
    try {
      fs.writeFileSync(dbPath, JSON.stringify(next, null, 2));
      memoryDb = next;
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'No se pudo guardar el orden.' });
    }
  });

  app.get("/api/documents", (req, res) => {
    try {
      const db = getDb();
      const isAdmin = req.query.admin === 'true';
      if (isAdmin) {
          if (!hasAdminAccess(req)) return res.status(401).json({ error: "No autorizado" });
          // Strip the heavy pre-extracted text here too (admin list view).
          res.json(db.documents
            .filter((d: any) => !d.isDeleted)
            .map(({ searchIndex, ...rest }: any) => rest)
          );
      } else {
          res.json(db.documents
            .filter((d: any) => !d.isDeleted && d.status === 'ready')
            .map(withPublicDocumentAssets)
          );
      }
    } catch (e) {
      console.error("Error fetching documents:", e);
      res.status(500).json({ error: "Failed to fetch documents from db" });
    }
  });

  app.get("/api/search", async (req, res) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const normalizedQuery = normalizeSearchText(query);

      if (normalizedQuery.length < 2) {
        return res.json({ query, results: [], totalPdf: 0 });
      }

      const db = getDb();
      const docs = db.documents.filter((d: any) => !d.isDeleted && d.status === "ready");
      const results: any[] = [];

      for (const doc of docs) {
        const publicDoc = withPublicDocumentAssets(doc);
        const normalizedTitle = normalizeSearchText(doc.title || "");
        const normalizedDescription = normalizeSearchText(doc.description || "");

        if (normalizedTitle.includes(normalizedQuery)) {
          results.push({
            catalogId: doc.id,
            title: doc.title,
            description: doc.description,
            coverUrl: publicDoc.coverUrl,
            totalPages: doc.pageCount,
            pageNumber: 1,
            snippet: doc.title,
            matchText: query,
            source: "catalog-title",
          });
        } else if (normalizedDescription.includes(normalizedQuery)) {
          results.push({
            catalogId: doc.id,
            title: doc.title,
            description: doc.description,
            coverUrl: publicDoc.coverUrl,
            totalPages: doc.pageCount,
            pageNumber: 1,
            snippet: doc.description || "",
            matchText: query,
            source: "catalog-description",
          });
        }
      }

      const pdfDocs = docs.filter((doc: any) => {
        const fileUrl = typeof doc.fileUrl === "string" ? doc.fileUrl : "";
        return fileUrl.toLowerCase().split("?")[0].endsWith(".pdf");
      });

      for (const doc of pdfDocs) {
        try {
          const index = await ensureSearchIndex(doc);
          if (!index) continue;

          for (const page of index.pages) {
            const matchIndex = page.normalizedText.indexOf(normalizedQuery);
            if (matchIndex === -1) continue;

            results.push({
              catalogId: doc.id,
              title: doc.title,
              description: doc.description,
              coverUrl: index.coverUrl,
              totalPages: index.totalPages,
              pageNumber: page.pageNumber,
              snippet: createSearchSnippet(page.text, normalizedQuery, matchIndex),
              matchText: query,
              source: "pdf-content",
            });
          }
        } catch (error: any) {
          console.warn(`[SEARCH] Skipped ${doc.title}:`, error?.message || error);
        }
      }

      results.sort((a, b) => {
        if (a.source !== "pdf-content" && b.source === "pdf-content") return -1;
        if (a.source === "pdf-content" && b.source !== "pdf-content") return 1;
        return (a.pageNumber || 0) - (b.pageNumber || 0);
      });

      return res.json({ query, results, totalPdf: pdfDocs.length });
    } catch (e: any) {
      console.error("Error searching documents:", e);
      return res.status(500).json({ error: "Failed to search documents", message: e.message });
    }
  });

  // Per-document pre-extracted text, so the viewer can power its in-PDF search
  // instantly without parsing every page in the browser.
  app.get("/api/documents/:id/search-index", async (req, res) => {
    try {
      const db = getDb();
      const doc = db.documents.find((d: any) => d.id === req.params.id && !d.isDeleted);
      if (!doc) return res.status(404).json({ error: "Document not found" });

      const index = await ensureSearchIndex(doc);
      if (!index) return res.json({ id: doc.id, totalPages: doc.pageCount || 0, pages: [] });

      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({
        id: doc.id,
        totalPages: index.totalPages,
        pages: index.pages.map((p: any) => ({ page: p.pageNumber, text: p.text })),
      });
    } catch (e: any) {
      console.error("Error building search index:", e);
      return res.status(500).json({ error: "Failed to build search index", message: e.message });
    }
  });

  app.get("/api/promotional-banner", (req, res) => {
    try {
      const db = getDb();
      if (ensurePromotionalBannerConfig(db)) {
        saveDb(db);
      }
      return res.json(db.promotionalBanner);
    } catch (e: any) {
      console.error("Error fetching promotional banner:", e);
      return res.status(500).json({ error: "Failed to fetch promotional banner" });
    }
  });

  app.put("/api/promotional-banner", requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const previousBanner = db.promotionalBanner || {};
      const nextBanner = normalizePromotionalBanner(
        {
          imageUrl: req.body?.imageUrl,
          mobileImageUrl: req.body?.mobileImageUrl,
          mobileIsActive: req.body?.mobileIsActive,
          altText: req.body?.altText,
          targetUrl: req.body?.targetUrl,
          isActive: req.body?.isActive,
          updatedAt: new Date().toISOString(),
        },
        buildDefaultPromotionalBanner(db),
      );

      db.promotionalBanner = nextBanner;
      saveDb(db);
      const activeUrls = new Set([nextBanner.imageUrl, nextBanner.mobileImageUrl]);
      for (const previousUrl of [previousBanner.imageUrl, previousBanner.mobileImageUrl]) {
        if (previousUrl && !activeUrls.has(previousUrl)) await deleteStoredAsset(previousUrl);
      }
      return res.json(nextBanner);
    } catch (e: any) {
      console.error("Error updating promotional banner:", e);
      return res.status(500).json({ error: e.message || "Failed to update promotional banner" });
    }
  });

  app.post("/api/promotional-banner/upload-image", requireAdmin, upload.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No image file provided" });
      const allowedBannerTypes: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
      };
      const ext = allowedBannerTypes[String(req.file.mimetype || "").toLowerCase()];
      if (!ext) {
        await fs.promises.unlink(req.file.path).catch(() => undefined);
        return res.status(400).json({ error: "Only PNG, JPEG, or WebP images are allowed" });
      }

      const filename = `banner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const finalPath = path.join(BASE_STORAGE, "banners", filename);

      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.promises.rename(req.file.path, finalPath);
      await uploadFileToB2(`banners/${filename}`, finalPath, req.file.mimetype);
      await fs.promises.unlink(finalPath).catch(() => undefined);

      return res.json({ imageUrl: `/storage/banners/${filename}` });
    } catch (err: any) {
      console.error("[PROMOTIONAL BANNER UPLOAD ERROR]:", err);
      return res.status(500).json({ error: err.message || "Failed to upload banner image" });
    }
  });

  app.get("/api/categories", (req, res) => {
    try {
      const db = getDb();
      if (ensureDefaultCategories(db)) {
        saveDb(db);
      }
      res.json((db.categories || []).sort((a: any, b: any) => (a.order || 0) - (b.order || 0)));
    } catch (e) {
      console.error("Error fetching categories:", e);
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  });

  app.post("/api/categories", requireAdmin, (req, res) => {
    try {
      const db = getDb();
      if (!db.categories) db.categories = [];
      if (req.body.parentId && !db.categories.some((item: any) => item.id === req.body.parentId)) return res.status(400).json({ error: 'Categoría principal no encontrada.' });
      if (db.categories.some((item: any) => item.slug === req.body.slug || item.name === req.body.name)) return res.status(400).json({ error: 'Ya existe una categoría con ese nombre o dirección.' });
      
      const newCat = {
        id: `cat-${Date.now()}`,
        ...req.body,
        createdAt: new Date().toISOString()
      };
      
      db.categories.push(newCat);
      saveDb(db);
      res.json(newCat);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/categories/:id", requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const index = db.categories.findIndex((c: any) => c.id === req.params.id);
      if (index > -1) {
        const currentCategory = db.categories[index];
        const previousImageUrl = currentCategory.imageUrl;
        const updates = { ...req.body };
        if (updates.parentId && (!db.categories.some((item: any) => item.id === updates.parentId) || categoryBranch(db.categories, currentCategory.id).some((item: any) => item.id === updates.parentId))) {
          return res.status(400).json({ error: 'La categoría principal no es válida.' });
        }
        if (db.categories.some((item: any) => item.id !== currentCategory.id && ((updates.name && item.name === updates.name) || (updates.slug && item.slug === updates.slug)))) {
          return res.status(400).json({ error: 'Ya existe una categoría con ese nombre o dirección.' });
        }
        if (updates.name && updates.name !== currentCategory.name) {
          db.documents.forEach((document: any) => {
            if (document.category === currentCategory.name) document.category = updates.name;
          });
        }

        if (isDefaultCategory(currentCategory)) {
          updates.slug = currentCategory.slug;
        }

        db.categories[index] = { ...currentCategory, ...updates, updatedAt: new Date().toISOString() };
        saveDb(db);
        if (previousImageUrl && previousImageUrl !== db.categories[index].imageUrl) {
          await deleteStoredAsset(previousImageUrl);
        }
        res.json(db.categories[index]);
      } else {
        res.status(404).json({ error: "Category not found" });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/categories/:id", requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const category = (db.categories || []).find((c: any) => c.id === req.params.id);

      if (!category) {
        return res.status(404).json({ error: "Category not found" });
      }

      if (isDefaultCategory(category)) {
        return res.status(400).json({ error: "Default catalog categories cannot be deleted" });
      }

      await deleteStoredAsset(category.imageUrl);
      db.categories = (db.categories || []).filter((c: any) => c.id !== req.params.id);
      saveDb(db);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/categories/upload-icon", requireAdmin, upload.single('icon'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No icon file provided" });
      
      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `cat-icon-${Date.now()}${ext}`;
      const finalPath = path.join(BASE_STORAGE, "categories", filename);
      
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.promises.rename(req.file.path, finalPath);
      await uploadFileToB2(`categories/${filename}`, finalPath, req.file.mimetype);
      await fs.promises.unlink(finalPath).catch(() => undefined);
      
      res.json({ imageUrl: `/storage/categories/${filename}` });
    } catch (err: any) {
      console.error("[CATEGORY ICON UPLOAD ERROR]:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/documents/:id/swap", requireAdmin, async (req, res) => {
    try {
      const { newDocId } = req.body;
      const targetId = req.params.id;

      if (!newDocId) return res.status(400).json({ error: "Missing newDocId" });

      const db = getDb();
      const targetIndex = db.documents.findIndex((d: any) => d.id === targetId);
      const newIndex = db.documents.findIndex((d: any) => d.id === newDocId);

      if (targetIndex === -1 || newIndex === -1) {
        return res.status(404).json({ error: "One or both documents not found" });
      }

      const targetDoc = db.documents[targetIndex];
      const newDoc = db.documents[newIndex];

      // Store old fileUrl for cleanup
      const oldFileUrl = targetDoc.fileUrl;
      const oldCoverUrl = targetDoc.coverUrl;

      console.log(`[SWAP] Replacing ${targetDoc.id} with content from ${newDoc.id}`);

      // 1. Swap metadata (except ID and core info like creation date if we had one)
      targetDoc.fileUrl = newDoc.fileUrl;
      targetDoc.coverUrl = newDoc.coverUrl;
      targetDoc.pageCount = newDoc.pageCount;
      targetDoc.status = "ready";
      targetDoc.updatedAt = new Date().toISOString();
      
      // Preserve status and other tags if needed, or update from new doc if user changed them
      // For now, only replacing the physical content is the priority
      
      // 2. Remove the temporary "new" document entry
      db.documents.splice(newIndex, 1);

      saveDb(db);

      // 3. Remove the replaced assets from Backblaze and any legacy local copy.
      await deleteStoredAsset(oldFileUrl);
      if (oldCoverUrl && oldCoverUrl !== targetDoc.coverUrl) {
        await deleteStoredAsset(oldCoverUrl);
      }

      res.json(targetDoc);
    } catch (error: any) {
      console.error("[SWAP ERROR]:", error);
      res.status(500).json({ error: error.message || "Swap failed" });
    }
  });

  app.get("/api/documents/:id/cover", (req, res) => {
    try {
      const db = getDb();
      const doc = db.documents.find((d: any) => d.id === req.params.id && !d.isDeleted);
      const imageData = parseImageDataUrl(doc?.coverUrl);

      if (!doc || !imageData) {
        return res.status(404).json({ error: "Cover not found" });
      }

      const imageBuffer = Buffer.from(imageData.base64, "base64");
      res.setHeader("Content-Type", imageData.contentType);
      res.setHeader("Content-Length", imageBuffer.length);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(imageBuffer);
    } catch (e) {
      console.error("Error fetching document cover:", e);
      return res.status(500).json({ error: "Failed to fetch document cover" });
    }
  });

  app.get("/api/documents/:id", (req, res) => {
    try {
      const db = getDb();
      const doc = db.documents.find((d: any) => d.id === req.params.id && !d.isDeleted);
      if (doc) {
        const { searchIndex, ...rest } = doc;
        res.json(rest);
      } else {
        res.status(404).json({ error: "Document not found" });
      }
    } catch (e) {
      console.error("Error fetching document:", e);
      res.status(500).json({ error: "Failed to fetch document" });
    }
  });

  app.post("/api/documents/import", requireAdmin, (req, res) => {
    const item = req.body;
    setTimeout(() => {
        try {
            const db = getDb();
            const newDoc = {
                id: `doc-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                title: item.title,
                description: '',
                category: item.category,
                pageCount: 1,
                coverUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
                fileUrl: item.url,
                tags: [],
                status: "ready",
                sourceType: item.type,
                visibility: "public"
            };
            db.documents.unshift(newDoc);
            saveDb(db);
            res.json(newDoc);
        } catch (error) {
            console.error("Import processing error:", error);
            res.status(500).json({ error: "Processing failed" });
        }
    }, 1500);
  });

  app.post("/api/documents/:id/index", requireAdmin, (req, res) => {
    try {
      const db = getDb();
      const docIndex = db.documents.findIndex((d: any) => d.id === req.params.id);
      if (docIndex > -1) {
        db.documents[docIndex].indexItems = req.body.indexItems;
        db.documents[docIndex].updatedAt = new Date().toISOString();
        saveDb(db);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Document not found" });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/documents/:id", requireAdmin, (req, res) => {
    upload.single("cover")(req, res, async (err) => {
      if (err) {
        console.error("Multer error:", err);
        return res.status(400).json({ error: "Upload processing failed" });
      }

      try {
        const db = getDb();
        const docIndex = db.documents.findIndex((d: any) => d.id === req.params.id);
        
        if (docIndex > -1) {
          const doc = db.documents[docIndex];
          const previousCoverUrl = doc.coverUrl;
          const updateData = req.body;
          
          if (updateData.title) doc.title = updateData.title;
          if (updateData.description !== undefined) doc.description = updateData.description;
          if (updateData.category) doc.category = updateData.category;
          if (updateData.pageCount) doc.pageCount = parseInt(updateData.pageCount, 10);
          if (updateData.visibility) doc.visibility = updateData.visibility;
          if (updateData.publicationType === "catalog" || updateData.publicationType === "technical-sheet") {
            doc.publicationType = updateData.publicationType;
          }
          if (updateData.status) doc.status = updateData.status;
          if (updateData.coverUrl) doc.coverUrl = updateData.coverUrl;
          if (updateData.fileUrl !== undefined) doc.fileUrl = updateData.fileUrl;
          if (updateData.externalUrl !== undefined) doc.externalUrl = updateData.externalUrl;
          if (updateData.priority !== undefined) doc.priority = parseInt(updateData.priority, 10);
          if (updateData.isActive !== undefined) doc.isActive = updateData.isActive === 'true';
          if (updateData.order !== undefined) doc.order = parseInt(updateData.order, 10);

          
          if (req.file) {
            try {
               const allowedCoverTypes: Record<string, string> = {
                 "image/jpeg": ".jpg",
                 "image/png": ".png",
                 "image/webp": ".webp",
               };
               const mimeType = String(req.file.mimetype || "").toLowerCase();
               const ext = allowedCoverTypes[mimeType];
               if (!ext) {
                 await fs.promises.unlink(req.file.path).catch(() => undefined);
                 return res.status(400).json({ error: "La portada debe ser PNG, JPEG o WebP" });
               }
               const filename = `${encodeURIComponent(doc.id)}-${Date.now()}${ext}`;
               const storageKey = `covers/${filename}`;
               await uploadFileToB2(storageKey, req.file.path, mimeType);
               await fs.promises.unlink(req.file.path).catch(() => undefined);
               doc.coverUrl = `/storage/${storageKey}`;
            } catch (err) {
               console.error("Cover convert error:", err);
               return res.status(500).json({ error: "No se pudo guardar la portada en Backblaze" });
            }
          }

          saveDb(db);
          if (previousCoverUrl && previousCoverUrl !== doc.coverUrl) {
            await deleteStoredAsset(previousCoverUrl);
          }
          res.json(doc);
        } else {
          res.status(404).json({ error: "Document not found" });
        }
      } catch (error: any) {
        console.error("Update error:", error);
        res.status(500).json({ error: "Update failed: " + (error.message || String(error)) });
      }
    });
  });

  app.delete("/api/documents/:id", requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const docIndex = db.documents.findIndex((d: any) => d.id === req.params.id);
      
      if (docIndex === -1) {
          console.log(`[DELETE] Document ${req.params.id} not found in DB`);
          return res.status(404).json({ error: "Document not found" });
      }

      const doc = { ...db.documents[docIndex] };
      console.log(`[DELETE] Removing document: ${doc.title} (${doc.id})`);

      // 1. Remove physical assets from Backblaze and any legacy local copy.
      await deleteStoredAsset(doc.fileUrl);
      await deleteStoredAsset(doc.coverUrl);

      // 2. Permanent metadata removal.
      db.documents = db.documents.filter((d: any) => d.id !== req.params.id);
      saveDb(db);

      res.json({ success: true, docId: doc.id });
    } catch (err: any) {
      console.error("[DELETE ERROR]:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // Secure PDF Proxy
  app.get("/api/pdf-proxy", async (req, res) => {
    let targetUrl = req.query.url as string;
    
    if (!targetUrl) {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      let url: URL | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          url = new URL(targetUrl);
          break;
        } catch (parseError) {
          try {
            const decodedUrl = decodeURIComponent(targetUrl);
            if (decodedUrl === targetUrl) throw parseError;
            targetUrl = decodedUrl;
          } catch {
            throw parseError;
          }
        }
      }

      if (!url) {
        throw new Error("Invalid URL");
      }
      targetUrl = url.href;
      
      // Basic security checks
      if (!["http:", "https:"].includes(url.protocol)) {
        return res.status(400).json({ error: "Only http and https protocols are allowed" });
      }

      // Block loopback / private / link-local / metadata ranges (SSRF guard)
      if (isBlockedHost(url.hostname)) {
        return res.status(403).json({ error: "Access to local/private network is forbidden" });
      }

      const axios = (await import("axios")).default;

      // Forward the browser's Range header so pdf.js can stream byte ranges and
      // render the first page without downloading the whole file.
      const forwardHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      };
      if (typeof req.headers.range === "string") {
        forwardHeaders["Range"] = req.headers.range;
      }

      const response = await axios.get(targetUrl, {
        responseType: "stream",
        maxContentLength: 500 * 1024 * 1024, // 500MB limit
        maxRedirects: 5,
        beforeRedirect: (options: any) => {
          const redirectProtocol = String(options?.protocol || "").toLowerCase();
          const redirectHostname = String(options?.hostname || "");
          if (!["http:", "https:"].includes(redirectProtocol) || isBlockedHost(redirectHostname)) {
            throw new Error("Unsafe PDF redirect blocked");
          }
        },
        timeout: 20000,
        headers: forwardHeaders,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      res.status(response.status === 206 ? 206 : 200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      // External catalogs change rarely; cache for an hour to avoid re-fetching.
      res.setHeader("Cache-Control", "public, max-age=3600");
      for (const h of ["content-length", "content-range", "last-modified", "etag"]) {
        const v = response.headers[h];
        if (v) res.setHeader(h, v as string);
      }

      response.data.on("error", (streamErr: any) => {
        console.error("PDF Proxy stream error:", streamErr?.message);
        if (!res.headersSent) res.status(502).json({ error: "Upstream stream error" });
        else res.end();
      });
      response.data.pipe(res);
    } catch (error: any) {
      console.error("PDF Proxy error:", error.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Failed to fetch PDF: " + (error.response?.statusText || error.message) });
      }
    }
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // Global Error Handler for API
  app.use((err: any, req: any, res: any, next: any) => {
    if (req.url.startsWith('/api')) {
      console.error("[GLOBAL API ERROR]", err);
      return res.status(500).json({ 
        error: "Error interno del servidor", 
        message: err.message,
        path: req.url 
      });
    }
    next(err);
  });

  // Retired administrator entry points must not redirect to the current
  // administrator. Keeping them as hard 404s leaves /admin as the only URL.
  app.use((req, res, next) => {
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';
    const isRetiredAdminPath = normalizedPath === '/login'
      || normalizedPath === '/gestion-interna'
      || normalizedPath.startsWith('/gestion-interna/');

    if (!isRetiredAdminPath) return next();

    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).type('text/plain').send('Página no encontrada');
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    // On-the-fly gzip for text-based production assets (JS/CSS/MJS/SVG/JSON),
    // cached in memory per file+mtime. Hashed /assets/* get an immutable cache
    // header. Binary assets (images, fonts) fall through to express.static.
    const gzCache = new Map<string, { mtime: number; buf: Buffer }>();
    const TEXT_TYPES: Record<string, string> = {
      ".js": "application/javascript; charset=utf-8",
      ".mjs": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
    };
    app.use((req, res, next) => {
      if (req.method !== "GET") return next();
      const accepts = String(req.headers["accept-encoding"] || "");
      if (!/\bgzip\b/.test(accepts)) return next();
      const ext = path.extname(req.path).toLowerCase();
      const type = TEXT_TYPES[ext];
      if (!type) return next();

      const filePath = path.join(distPath, decodeURIComponent(req.path));
      if (!filePath.startsWith(distPath) || !fs.existsSync(filePath)) return next();

      try {
        const stat = fs.statSync(filePath);
        const key = filePath;
        let entry = gzCache.get(key);
        if (!entry || entry.mtime !== stat.mtimeMs) {
          entry = { mtime: stat.mtimeMs, buf: zlib.gzipSync(fs.readFileSync(filePath)) };
          gzCache.set(key, entry);
        }
        res.setHeader("Content-Type", type);
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Content-Length", String(entry.buf.length));
        res.setHeader(
          "Cache-Control",
          req.path.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600"
        );
        return res.end(entry.buf);
      } catch {
        return next();
      }
    });

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Repair DB metadata on start
  const repairDatabase = async () => {
    try {
      console.log("[REPAIR] Checking database for missing fileSize metadata...");
      const db = getDb();
      let changed = false;

      if (db && db.documents) {
        for (const doc of db.documents) {
          if (doc.fileUrl && doc.fileUrl.startsWith("/storage/") && doc.fileUrl.toLowerCase().split("?")[0].endsWith(".pdf")) {
            const relativePath = doc.fileUrl.replace("/storage/", "");
            const fullPath = resolveStoredFilePath(relativePath);
            const hasValidLocalFile = fs.existsSync(fullPath) && isPdfFileValid(fullPath);
            const remoteObject = hasValidLocalFile ? null : await headB2Object(relativePath);
            const availableSize = hasValidLocalFile
              ? fs.statSync(fullPath).size
              : Number(remoteObject?.ContentLength || 0);

            if (!doc.fileSize && availableSize > 0) {
              doc.fileSize = availableSize;
              changed = true;
              console.log(`[REPAIR] Updated fileSize for ${doc.id}: ${doc.fileSize} bytes`);
            }

            if (!hasValidLocalFile && !remoteObject) {
              if (doc.status !== "error") {
                doc.status = "error";
                doc.updatedAt = new Date().toISOString();
                changed = true;
                console.warn(`[REPAIR] PDF missing locally and in Backblaze: ${doc.id}`);
              }
            }
          }
        }
      }

      if (changed) {
        saveDb(db);
        console.log("[REPAIR] Database metadata updated successfully.");
      } else {
        console.log("[REPAIR] No documents needed updating.");
      }
    } catch (error) {
      console.error("[REPAIR ERROR] Failed to repair database metadata:", error);
    }
  };

  await repairDatabase();
  await cleanupAbandonedUploadSessions().catch((error) => {
    console.warn("[UPLOAD CLEANUP] Startup cleanup failed:", error?.message || error);
  });
  const uploadCleanupTimer = setInterval(() => {
    cleanupAbandonedUploadSessions().catch((error) => {
      console.warn("[UPLOAD CLEANUP] Periodic cleanup failed:", error?.message || error);
    });
  }, 10 * 60 * 1000);
  uploadCleanupTimer.unref?.();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // In the background (non-blocking): first optimize existing PDFs for Fast
    // Web View (if qpdf is present), then pre-build search indexes so the very
    // first search after a restart is already fast.
    setTimeout(() => {
      linearizeExistingPdfs()
        .catch((e) => console.warn("[LINEARIZE] error:", e?.message || e))
        .finally(() => {
          backfillSearchIndexes().catch((e) => console.warn("[SEARCH INDEX] Backfill error:", e?.message || e));
        });
    }, 1500);
  }).on('error', (err) => {
    console.error('Server listen error:', err);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
