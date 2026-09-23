import React from 'react';
import { Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import CatalogPreviewCard from '../library/CatalogPreviewCard';
import { formatFileSize } from '../../lib/viewerUtils';

interface CatalogViewerDetailsProps {
  title: string;
  coverUrl: string;
  numPages: number;
  loading: boolean;
  downloadPdf: () => void;
  canDownload: boolean;
  pageCount?: number;
  fileSize?: number;
  relatedDocuments?: any[];
  onRelatedClick?: (id: string) => void;
}

const CatalogViewerDetails: React.FC<CatalogViewerDetailsProps> = ({
  title,
  coverUrl,
  numPages,
  loading,
  downloadPdf,
  canDownload,
  pageCount,
  fileSize,
  relatedDocuments = [],
}) => {
  const navigate = useNavigate();

  return (
    <section className="catalog-viewer-details-section">
      <div className="catalog-viewer-details-inner">
        <div className="catalog-main-info">
          <div className="catalog-info-cover-block">
            <CatalogPreviewCard 
              title={title}
              image={coverUrl || "/images/placeholders/catalog_chaide_1.jpg"}
              year={title.match(/\b20\d{2}\b/)?.[0]}
              size="md"
              hideInfo={true}
            />
            <h2>{title}</h2>
          </div>

          <div className="catalog-info-meta-block">
            <div className="catalog-meta-grid">
              <div className="catalog-meta-item">
                <span>PUBLICADO</span>
                <strong>15 de mayo, 2026</strong>
              </div>
              <div className="catalog-meta-item">
                <span>PÁGINAS</span>
                <strong>{loading || numPages === 0 ? "Cargando..." : `${numPages} ${numPages === 1 ? "página" : "páginas"}`}</strong>
              </div>
            </div>
            <button 
              onClick={downloadPdf}
              disabled={!canDownload}
              className="catalog-download-info-button flex items-center gap-4 text-left p-4 pr-6"
            >
              <div className="w-10 h-10 rounded-full bg-gray-900 text-white flex items-center justify-center flex-shrink-0">
                <Download className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <strong className="text-sm font-bold text-gray-900">Descargar catálogo</strong>
                <small className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
                  PDF {fileSize ? formatFileSize(fileSize) : "--- MB"}
                </small>
              </div>
            </button>
          </div>
        </div>

        <div className="related-catalogs-block">
          <div className="related-catalogs-header">
            <h2>Catálogos relacionados</h2>
            <button 
              onClick={() => navigate('/')}
              className="text-blue-600 font-bold hover:underline"
            >
              Ver todos &gt;
            </button>
          </div>
          <div className="related-catalogs-row">
            {relatedDocuments.map((doc, idx) => (
              <CatalogPreviewCard
                key={doc.id || idx}
                title={doc.title}
                subtitle={doc.category}
                coverTitle={doc.title}
                year={doc.title.match(/\b20\d{2}\b/)?.[0]}
                image={doc.coverUrl}
                href={`/viewer/${doc.id}`}
                size="sm"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default CatalogViewerDetails;
