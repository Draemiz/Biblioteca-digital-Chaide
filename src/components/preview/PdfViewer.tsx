import React, { useMemo } from 'react';
import { detectViewerSource, extractSafeEmbedUrl, getPdfProxyUrl } from '../../lib/viewerUtils';
import ProfessionalFlipbook from './ProfessionalFlipbook';

interface PdfViewerProps {
  documentId: string;
  url: string; // This could be a URL or HTML code
  title: string;
  onClose?: () => void;
  downloadUrl?: string;
  initialPage?: number;
  initialSearch?: string;
  onPageChange?: (page: number) => void;
}

export default function PdfViewer({ documentId, url, title, onClose, downloadUrl, initialPage, initialSearch, onPageChange }: PdfViewerProps) {
  const source = useMemo(() => {
    const detected = detectViewerSource(url);
    if (detected.type !== 'embed-html') return detected;
    const safeUrl = extractSafeEmbedUrl(detected.value);
    return safeUrl
      ? detectViewerSource(safeUrl)
      : { type: 'unknown' as const, value: '' };
  }, [url]);

  const handleDownload = async () => {
    const finalDownloadUrl = downloadUrl || (source.type === 'pdf-url' ? source.value : null);
    
    if (!finalDownloadUrl) {
      alert('La descarga no está disponible para este catálogo.');
      return;
    }

    try {
      const proxiedUrl = getPdfProxyUrl(finalDownloadUrl);
      const response = await fetch(proxiedUrl);
      if (!response.ok) throw new Error('Fetch failed');
      
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${title.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    } catch (e) {
      console.error('Download failed:', e);
      window.open(finalDownloadUrl, '_blank', 'noopener,noreferrer');
    }
  };

  // Case 1: Direct PDF Link -> Use our professional Flipbook
  if (source.type === 'pdf-url') {
    const proxiedUrl = getPdfProxyUrl(source.value);
    return (
      <ProfessionalFlipbook 
        documentId={documentId}
        url={proxiedUrl} 
        title={title} 
        onClose={onClose} 
        downloadUrl={downloadUrl} 
        initialPage={initialPage}
        initialSearch={initialSearch}
        onPageChange={onPageChange}
      />
    );
  }

  // External embeds are reduced to a URL and isolated in a sandboxed iframe.
  if (source.type === 'embed-url') {
    let finalUrl = source.value;
    
    // Additional normalization for common providers
    if (source.provider === 'google-drive') {
      finalUrl = finalUrl.replace('/view', '/preview').replace('/edit', '/preview');
    }

    return (
      <div className="w-full h-full bg-[#1a1a1a] flex flex-col">
          <div className="h-14 bg-[#1a1a1a] flex items-center justify-between px-4 shrink-0 border-b border-white/5">
          <div className="flex items-center gap-3">
             <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full text-gray-400">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
             </button>
             <h2 className="text-sm font-bold text-white">{title}</h2>
          </div>
          <div className="flex items-center gap-3">
             <button 
              onClick={handleDownload} 
              className="p-2 hover:bg-white/10 rounded-full text-gray-400 group"
              title="Descargar PDF"
             >
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:text-white"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
             </button>
             <div className="text-[10px] text-gray-500 uppercase tracking-widest font-medium">Origen: {source.provider}</div>
          </div>
        </div>
        <iframe 
          src={finalUrl} 
          title={title}
          className="flex-1 w-full h-full border-0"
          allow="autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }

  // Final Fallback: Error
  return (
    <div className="flex flex-col items-center justify-center h-full text-gray-400 p-8 text-center bg-[#1a1a1a]">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-500 mb-4"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m9.5 12.5 5 5"/><path d="m14.5 12.5-5 5"/></svg>
      <h3 className="text-white font-bold mb-2">No hay un contenido válido configurado</h3>
      <p className="text-sm">El administrador aún no ha cargado un PDF o un enlace válido para este catálogo.</p>
    </div>
  );
}
