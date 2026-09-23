import React, { useRef } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PDFCard from './PDFCard';
import { DocumentDef } from '../../lib/mockData';

interface PDFCarouselProps {
  title: string;
  docs: DocumentDef[];
}

export default function PDFCarousel({ title, docs }: PDFCarouselProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const { scrollLeft, clientWidth } = scrollContainerRef.current;
      const scrollAmount = clientWidth * 0.75;
      scrollContainerRef.current.scrollTo({
        left: direction === 'left' ? scrollLeft - scrollAmount : scrollLeft + scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  if (!docs.length) return null;

  return (
    <div className="relative py-6 group/carousel">
      <div className="px-6 lg:px-12 mb-4 flex items-center justify-between">
        <h2 className="text-xl md:text-3xl font-bold tracking-tight" style={{ color: '#111' }}>{title}</h2>
        <button 
          onClick={() => navigate('/buscar?q=')}
          className="text-sm font-medium hover:underline transition-all" 
          style={{ color: 'rgba(0,0,0,0.62)' }}
        >
          Ver todo
        </button>
      </div>

      <div className="relative">
        <button 
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-20 w-12 h-2/3 bg-white/50 backdrop-blur-sm opacity-0 group-hover/carousel:opacity-100 hover:bg-white/80 hover:text-black flex items-center justify-center transition-all disabled:opacity-0 rounded-r-xl border border-gray-200"
        >
          <ChevronLeft className="w-8 h-8" />
        </button>

        <div 
          ref={scrollContainerRef}
          className="flex gap-4 md:gap-6 px-6 lg:px-12 overflow-x-auto custom-scrollbar pb-8 pt-4 snap-x snap-mandatory"
        >
          {docs.map(doc => (
            <div key={doc.id} className="snap-start" style={{ width: '180px' }}>
              <PDFCard doc={doc} />
            </div>
          ))}
          <div className="shrink-0 w-6" /> {/* spacer */}
        </div>

        <button 
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 w-12 h-2/3 bg-white/50 backdrop-blur-sm opacity-0 group-hover/carousel:opacity-100 hover:bg-white/80 hover:text-black flex items-center justify-center transition-all disabled:opacity-0 rounded-l-xl border border-gray-200"
        >
          <ChevronRight className="w-8 h-8" />
        </button>
      </div>
    </div>
  );
}
