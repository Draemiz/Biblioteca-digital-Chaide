import React, { useState, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { normalizeGoogleDriveLink } from '../../lib/driveUtils';

export function DriveIframePreloader() {
  const { documents } = useStore();
  const [preloadingIds, setPreloadingIds] = useState<string[]>([]);

  useEffect(() => {
    // Determine the highest priority Google Drive documents to preload
    const driveDocuments = documents.filter(d => 
      d.isActive !== false && 
      (d.externalUrl?.includes('drive.google.com') || d.fileUrl?.includes('drive.google.com'))
    );

    // Sort by priority (lower number = higher priority), then by order
    const sorted = [...driveDocuments].sort((a, b) => {
      const priorityA = a.priority ?? 5; // Default priority 5
      const priorityB = b.priority ?? 5;
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      const orderA = a.order ?? 999;
      const orderB = b.order ?? 999;
      return orderA - orderB;
    });

    // We only want to preload top 2 to avoid blocking network and memory.
    const topToPreload = sorted.slice(0, 2).map(d => d.id);
    
    // Slight delay to ensure main React/Vite UI thread parses first smoothly
    const timer = setTimeout(() => {
        setPreloadingIds(topToPreload);
    }, 2000);

    return () => clearTimeout(timer);
  }, [documents]);

  return (
    <div style={{ display: 'none' }} aria-hidden="true" data-testid="hidden-preloader">
      {preloadingIds.map(id => {
        const doc = documents.find(d => d.id === id);
        if (!doc) return null;
        
        const url = doc.externalUrl || doc.fileUrl;
        const optimizedUrl = normalizeGoogleDriveLink(url);
        
        if (!optimizedUrl) return null;
        
        return (
          <iframe 
            key={id}
            src={optimizedUrl}
            title={`preload-${id}`}
            loading="lazy" 
          />
        );
      })}
    </div>
  );
}
