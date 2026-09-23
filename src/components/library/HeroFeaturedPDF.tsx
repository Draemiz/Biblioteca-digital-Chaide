import React from 'react';
import { Play, Bookmark } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { DocumentDef } from '../../lib/mockData';

export default function HeroFeaturedPDF({ doc }: { doc: DocumentDef }) {
  const navigate = useNavigate();

  return (
    <div className="relative w-full h-[60vh] min-h-[500px] flex items-center overflow-hidden rounded-bl-3xl border-b border-white/5">
      {/* Background Image with strong blur and overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-40 scale-105 transition-transform duration-[2000ms] group-hover:scale-110 group-hover:blur-sm"
        style={{ backgroundImage: `url(${doc.coverUrl})` }}
      />
      <div className="absolute inset-0 bg-[#05070d]/60" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#05070d] via-[#05070d]/40 to-transparent" />

      {/* Content */}
      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-12 flex flex-col md:flex-row items-center gap-8 md:gap-16">
        
        {/* Left: Text & Actions */}
        <div className="flex-1 space-y-6 pt-12 md:pt-0">
          <div className="flex items-center gap-3 text-sm font-bold tracking-wider uppercase">
            <span className="text-blue-500">{doc.category}</span>
            <span className="text-white/40">•</span>
            <span className="text-white/60">{doc.pageCount} páginas</span>
            <span className="bg-red-500/10 text-red-500 px-3 py-1 rounded-full text-xs border border-red-500/20 font-bold">
              NUEVO
            </span>
          </div>
          
          <h1 className="text-6xl md:text-8xl lg:text-9xl font-extrabold leading-[0.9] tracking-[-0.075em] text-white">
            {doc.title}
          </h1>
          
          <p className="text-xl text-white/70 max-w-2xl leading-relaxed">
            {doc.description}
          </p>

          <div className="flex flex-wrap items-center gap-4 pt-4">
            <button 
              onClick={() => navigate(`/viewer/${doc.id}`)}
              className="primary-button flex items-center gap-2 group relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
              <Play className="w-5 h-5 fill-current" />
              Ingresar al visor
            </button>
            <button className="glass-button flex items-center justify-center p-4 transition-transform hover:scale-105 active:scale-95">
              <Bookmark className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Right: Large Poster */}
        <div className="hidden md:block shrink-0 group perspective-1000">
          <div className="w-[280px] lg:w-[340px] aspect-[2/3] transform transition-all duration-700 hover:rotate-y-0 rotate-y-[-10deg] shadow-[-20px_20px_30px_rgba(0,0,0,0.8)] rounded-xl overflow-hidden border border-white/10 group-hover:border-white/30 relative">
             <div className="absolute inset-0 bg-gradient-to-tr from-white/5 to-transparent z-10 pointer-events-none" />
             <img 
               src={doc.coverUrl} 
               alt={doc.title} 
               className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
             />
          </div>
        </div>
      </div>
    </div>
  );
}
