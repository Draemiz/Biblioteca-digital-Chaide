export interface DocumentIndexItem {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  source: 'outline' | 'auto' | 'ocr';
  score?: number;
  ocrConfidence?: number;
  children?: DocumentIndexItem[];
}

export interface DocumentDef {
  id: string;
  title: string;
  description: string;
  category: string;
  pageCount: number;
  coverUrl: string;
  fileUrl: string;
  tags: string[];
  isFeatured?: boolean;
  status?: 'ready' | 'processing' | 'error';
  sourceType?: 'upload' | 'url' | 'embed';
  publicationType?: 'catalog' | 'technical-sheet';
  storageProvider?: 'backblaze-b2' | 'local' | 'firebase' | 'drive';
  visibility?: string;
  externalUrl?: string;
  driveFileId?: string;
  driveMd5Checksum?: string;
  driveHistoricalFileIds?: string[];
  coverFileId?: string;
  driveBackupStatus?: 'ready' | 'error';
  storageVersion?: string;
  priority?: number;
  isActive?: boolean;
  order?: number;
  fileSize?: number;
  indexItems?: DocumentIndexItem[];
  searchIndexVersion?: string;
  searchIndexStatus?: 'ready' | 'no-text' | 'error';
  maintenanceStatus?: 'cleanup-pending' | 'ready';
  viewerOptimization?: {
    mode: 'original' | 'flattened';
    originalSize: number;
    viewerSize: number;
    imageOperations: number;
    maxImageOperationsPerPage: number;
    reason?: string;
  };
}

export const mockDocuments: DocumentDef[] = [
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
  },
  {
    id: "doc-2",
    title: "Manual de Descanso Óptimo",
    description: "Guía completa con consejos ergonómicos y rutinas para mejorar la calidad de tu sueño.",
    category: "Manual",
    pageCount: 12,
    coverUrl: "https://images.unsplash.com/photo-1505693314120-0d443867891c?q=80&w=800&auto=format&fit=crop",
    fileUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    tags: ["Salud", "Ergonomía"],
    status: "ready",
    sourceType: "upload"
  },
  {
    id: "doc-3",
    title: "Revista Estilo & Diseño Vol. 4",
    description: "Tendencias de diseño de interiores para dormitorios modernos y espacios minimalistas.",
    category: "Revista",
    pageCount: 24,
    coverUrl: "https://images.unsplash.com/photo-1522771731478-44fb10e9c31b?q=80&w=800&auto=format&fit=crop",
    fileUrl: "https://pdfobject.com/pdf/sample-3pp.pdf",
    tags: ["Diseño", "Tendencias"],
    status: "ready",
    sourceType: "upload"
  },
  {
    id: "doc-4",
    title: "Especificaciones Técnicas Línea Premium",
    description: "Detalles de materiales, resortes ensacados y memory foam de nuestra línea hotelera.",
    category: "Manual",
    pageCount: 8,
    coverUrl: "https://images.unsplash.com/photo-1615876234886-fdba0fce7cbf?q=80&w=800&auto=format&fit=crop",
    fileUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    tags: ["Técnico", "Premium", "Hotel"],
    status: "ready",
    sourceType: "url"
  },
  {
    id: "doc-5",
    title: "Catálogo Accesorios 2026",
    description: "Sábanas, edredones y protectores impermeables para complementar tu descanso.",
    category: "Catálogo",
    pageCount: 16,
    coverUrl: "https://images.unsplash.com/photo-1560934891-b3848b11c6d3?q=80&w=800&auto=format&fit=crop",
    fileUrl: "https://pdfobject.com/pdf/sample-3pp.pdf",
    tags: ["Accesorios", "Textiles"],
    status: "ready",
    sourceType: "embed"
  }
];
