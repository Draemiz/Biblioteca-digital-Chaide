import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, X, Bookmark, FileText, Calendar, Tag } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store/useStore';

export default function PDFPreviewModal() {
  const { previewDocId, setPreviewDocId, documents } = useStore();
  const navigate = useNavigate();
  
  const doc = documents.find(d => d.id === previewDocId);

  return (
    <AnimatePresence>
      {previewDocId && doc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={() => setPreviewDocId(null)}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }} 
            animate={{ opacity: 1, scale: 1, y: 0 }} 
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-4xl bg-[#111827] rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col md:flex-row max-h-[90vh]"
          >
             <button 
              onClick={() => setPreviewDocId(null)}
              className="absolute top-4 right-4 p-2 bg-black/50 hover:bg-black/80 rounded-full text-white z-20 backdrop-blur-md transition-colors"
             >
               <X className="w-5 h-5" />
             </button>

            {/* Left: Big Cover */}
            <div className="w-full md:w-2/5 shrink-0 relative bg-black/20">
               <div className="absolute inset-0 bg-gradient-to-t from-[#111827] md:from-transparent to-transparent z-10 md:hidden" />
               <img src={doc.coverUrl} alt={doc.title} className="w-full h-[300px] md:h-full object-cover" />
            </div>

            {/* Right: Details */}
            <div className="flex-1 p-6 md:p-10 overflow-y-auto custom-scrollbar flex flex-col text-left">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-2 pr-10">{doc.title}</h2>
              
              <div className="flex flex-wrap items-center gap-4 text-sm text-gray-400 mb-6">
                <span className="flex items-center gap-1.5"><Tag className="w-4 h-4" /> {doc.category}</span>
                <span className="flex items-center gap-1.5"><FileText className="w-4 h-4" /> {doc.pageCount} páginas</span>
                <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4" /> 2026</span>
              </div>

              <p className="text-gray-300 leading-relaxed mb-8 flex-1">
                {doc.description}
                <br/><br/>
                Explora el contenido completo en alta calidad con nuestro visor tipo libro. Puedes aplicar zoom, ver en pantalla completa y añadir a tus favoritos para continuar más tarde.
              </p>

              <div className="flex flex-wrap gap-2 mb-8">
                {doc.tags.map(t => (
                  <span key={t} className="bg-white/5 border border-white/10 px-3 py-1 rounded-full text-xs text-gray-300">
                    {t}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-white/5 shrink-0">
                <button 
                  onClick={() => {
                    setPreviewDocId(null);
                    navigate(`/viewer/${doc.id}`);
                  }}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-3.5 rounded-xl font-bold transition-transform active:scale-95"
                >
                  <Play className="w-5 h-5 fill-current" />
                  Ingresar al PDF
                </button>
                <button className="flex items-center justify-center p-3.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-colors shrink-0">
                  <Bookmark className="w-5 h-5 text-gray-300" />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
