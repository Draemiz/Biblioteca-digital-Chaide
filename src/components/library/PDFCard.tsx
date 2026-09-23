import React from 'react';
import { useNavigate } from 'react-router-dom';
import { DocumentDef } from '../../lib/mockData';
import CatalogPreviewCard from './CatalogPreviewCard';
import { prefetchPdfDocument } from '../../lib/pdfPrefetch';

const PDFCard: React.FC<{ doc: DocumentDef }> = ({ doc }) => {
  const navigate = useNavigate();

  return (
    <CatalogPreviewCard
      title={doc.title}
      subtitle={`${doc.publicationType === 'technical-sheet' ? 'Ficha técnica' : 'Catálogo'} · ${doc.category}`}
      coverTitle={doc.title}
      image={doc.coverUrl}
      href={`/viewer/${doc.id}`}
      onHover={() => prefetchPdfDocument(doc)}
      size="sm"
    />
  );
}

export default PDFCard;
