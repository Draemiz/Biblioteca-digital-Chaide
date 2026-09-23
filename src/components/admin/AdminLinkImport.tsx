import React, { useState } from 'react';
import { Link as LinkIcon, FileJson, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { useStore } from '../../store/useStore';

interface PendingImport {
  id: string;
  url: string;
  type: 'url' | 'embed';
  title: string;
  category: string;
  status: 'pending' | 'uploading' | 'ready' | 'error';
}

export default function AdminLinkImport() {
  const { fetchDocuments, categories } = useStore();
  const [queue, setQueue] = useState<PendingImport[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [importType, setImportType] = useState<'url'|'embed'>('url');

  const handleAddToQueue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput) return;
    
    setQueue(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      url: urlInput,
      type: importType,
      title: importType === 'url' ? 'Documento desde URL' : 'Documento Embebido',
      category: categories[0]?.name || 'Sin categoría',
      status: 'pending'
    }]);
    
    setUrlInput('');
  };

  const removeFromQueue = (id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  };
  
  const updateItemDetails = (id: string, field: string, value: string) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, [field]: value } : item));
  };

  const handleImportAll = async () => {
    const pendingUploads = queue.filter(item => item.status === 'pending' || item.status === 'error');
    if (pendingUploads.length === 0) return;

    setQueue(prev => prev.map(item => 
      pendingUploads.find(f => f.id === item.id) ? { ...item, status: 'uploading' } : item
    ));

    await Promise.all(
      pendingUploads.map(async (item) => {
        try {
          const res = await fetch('/api/documents/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item)
          });

          if (!res.ok) throw new Error('Import failed');

          setQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'ready' } : i));
        } catch {
          setQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error' } : i));
        }
      })
    );

    fetchDocuments();
  };

  const readyCount = queue.filter(q => q.status === 'ready').length;
  const isUploading = queue.some(q => q.status === 'uploading');
  
  return (
    <div className="bg-[#111827] border border-white/10 rounded-2xl p-6 mb-8 text-white">
      <h2 className="text-xl font-bold mb-4">Importar mediante URL o Embed</h2>
      
      <form onSubmit={handleAddToQueue} className="flex flex-col md:flex-row gap-3 mb-6">
        <select 
          value={importType} 
          onChange={e => setImportType(e.target.value as 'url'|'embed')}
          className="bg-[#0B0F19] border border-white/10 rounded-lg px-4 py-2.5 text-white focus:border-blue-500 focus:outline-none shrink-0"
        >
          <option value="url">Link directo / URL externa</option>
          <option value="embed">Código Iframe / Embed</option>
        </select>
        
        <input 
          type="text" 
          placeholder={importType === 'url' ? 'https://ejemplo.com/archivo.pdf' : '<iframe src="..."></iframe>'}
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          className="flex-1 bg-[#0B0F19] border border-white/10 rounded-lg px-4 py-2.5 text-white focus:border-blue-500 focus:outline-none"
        />
        
        <button type="submit" className="bg-white/10 hover:bg-white/20 text-white px-6 py-2.5 rounded-lg transition-colors font-medium shrink-0">
          Añadir a cola
        </button>
      </form>

      {queue.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <h3 className="font-semibold text-gray-200">Links pendientes de importar ({queue.length})</h3>
          </div>

          <div className="space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
            {queue.map(item => (
              <div key={item.id} className="bg-[#0B0F19] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 bg-white/5 rounded flex flex-col justify-center items-center shrink-0 border border-white/10">
                       {item.type === 'url' ? <LinkIcon className="w-5 h-5 text-gray-400" /> : <FileJson className="w-5 h-5 text-gray-400" />}
                    </div>
                    <div className="flex flex-col w-full">
                      <div className="flex gap-2">
                        <input 
                          type="text" 
                          value={item.title} 
                          onChange={(e) => updateItemDetails(item.id, 'title', e.target.value)}
                          disabled={item.status !== 'pending' && item.status !== 'error'}
                          className="bg-transparent border-none text-white font-medium focus:ring-1 focus:ring-blue-500 rounded px-1 -ml-1 text-sm flex-1 truncate"
                        />
                        <select 
                          value={item.category}
                          onChange={(e) => updateItemDetails(item.id, 'category', e.target.value)}
                          disabled={item.status !== 'pending' && item.status !== 'error'}
                          className="bg-[#0B0F19] border border-white/10 rounded px-2 py-0.5 text-xs text-gray-400 focus:outline-none focus:border-blue-500"
                        >
                          {categories.map(cat => (
                            <option key={cat.id} value={cat.name}>{cat.name}</option>
                          ))}
                          {categories.length === 0 && <option value="Sin categoría">Sin categoría</option>}
                        </select>
                      </div>
                      <div className="text-xs text-gray-500 truncate w-full max-w-[300px] mt-0.5">{item.url}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    {item.status === 'pending' && <span className="text-xs text-gray-500 bg-white/5 px-2 py-1 rounded">Pendiente</span>}
                    {item.status === 'uploading' && <span className="text-xs text-blue-400 bg-blue-400/10 px-2 py-1 rounded">Importando...</span>}
                    {item.status === 'ready' && <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/> Importado</span>}
                    {item.status === 'error' && <span className="text-xs text-red-400 bg-red-400/10 px-2 py-1 rounded flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Error</span>}
                    
                    {(item.status === 'pending' || item.status === 'error' || item.status === 'ready') && (
                      <button 
                        onClick={() => removeFromQueue(item.id)} 
                        className="group flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all"
                        title="Quitar"
                      >
                        <X className="w-5 h-5 group-hover:scale-110 transition-transform" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-4 border-t border-white/10 flex items-center justify-between">
            <div className="text-sm text-gray-400">
               {readyCount > 0 && <span>Progreso total: {readyCount} de {queue.length} listos</span>}
               {readyCount === queue.length && <span className="text-emerald-400 ml-2 font-medium">Importación completada. Formularios guardados en la base de datos interna.</span>}
            </div>
            
            <button 
              onClick={handleImportAll}
              disabled={isUploading || readyCount === queue.length}
              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-lg font-bold transition-all shadow-[0_0_20px_rgba(147,51,234,0.2)]"
            >
              {isUploading ? 'Importando...' : 'Importar todos'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
