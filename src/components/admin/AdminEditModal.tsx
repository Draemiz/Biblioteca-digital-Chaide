import React, { useState, useRef } from 'react';
import { X, Upload, FileText, Image as ImageIcon } from 'lucide-react';
import { DocumentDef } from '../../lib/mockData';
import { useStore } from '../../store/useStore';

interface AdminEditModalProps {
  document: DocumentDef;
  onClose: () => void;
}

export default function AdminEditModal({ document, onClose }: AdminEditModalProps) {
  const [title, setTitle] = useState(document.title);
  const [description, setDescription] = useState(document.description || '');
  const [category, setCategory] = useState(document.category || '');
  const [publicationType, setPublicationType] = useState(document.publicationType || 'catalog');
  const [pageCount, setPageCount] = useState(document.pageCount.toString());
  const [visibility, setVisibility] = useState(document.visibility || 'public');
  const [fileUrl, setFileUrl] = useState(document.fileUrl || '');
  const [externalUrl, setExternalUrl] = useState(document.externalUrl || '');
  const [priority, setPriority] = useState((document.priority ?? 5).toString());
  const [isActive, setIsActive] = useState(document.isActive !== false);

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string>(document.coverUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { categories, updateDocument } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setCoverFile(file);
      setCoverPreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const formData = new FormData();
      if (title !== document.title) formData.append('title', title);
      formData.append('description', description);
      if (category !== document.category) formData.append('category', category);
      if (publicationType !== document.publicationType) formData.append('publicationType', publicationType);
      if (pageCount !== document.pageCount.toString()) formData.append('pageCount', pageCount);
      if (visibility !== document.visibility) formData.append('visibility', visibility);
      formData.append('fileUrl', fileUrl);
      formData.append('externalUrl', externalUrl);
      
      const priorityVal = parseInt(priority, 10);
      if (priorityVal !== document.priority) formData.append('priority', priorityVal.toString());
      if (isActive !== document.isActive) formData.append('isActive', isActive.toString());
      
      if (coverFile) formData.append('cover', coverFile);

      await updateDocument(document.id, formData);
      onClose();
    } catch (err) {
      console.error(err);
      alert('Error updating document');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div 
        className="bg-[#111827] border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl relative"
        role="dialog"
        aria-modal="true"
      >
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="p-6">
          <h2 className="text-xl font-bold flex items-center gap-2 mb-6 text-white">
            <FileText className="w-5 h-5 text-blue-400" />
            Editar Documento
          </h2>

          <form data-lenis-prevent onSubmit={handleSubmit} className="space-y-4 text-sm max-h-[70vh] overflow-y-auto overscroll-contain custom-scrollbar pr-2">
            {/* Portada / Cover Upload */}
            <div>
              <label className="block text-gray-400 font-medium mb-2">Portada del Documento</label>
              <div className="flex items-center gap-4">
                <div className="w-24 h-32 bg-[#0B0F19] rounded-lg border border-white/10 overflow-hidden flex-shrink-0 relative group">
                  <img src={coverPreview} alt="Cover Preview" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <ImageIcon className="w-6 h-6 text-white" />
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-gray-400 text-xs mb-3">
                    Sube una imagen personalizada para la portada. Se recomienda formato vertical (aspect ratio 3:4).
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white font-medium transition-colors"
                  >
                    <Upload className="w-4 h-4" />
                    Cambiar Portada
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleImageChange}
                    accept="image/*"
                    className="hidden"
                  />
                </div>
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="block text-gray-400 font-medium mb-1.5">Nombre del Documento</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-gray-400 font-medium mb-1.5">Descripción</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 resize-none"
                placeholder="Escribe una breve descripción del documento..."
              />
            </div>

            {/* Embed / File Link */}
            <div>
              <label className="block text-gray-400 font-medium mb-1.5">Código de Inserción / Link Directo (fileUrl)</label>
              <input
                type="text"
                value={fileUrl}
                onChange={(e) => setFileUrl(e.target.value)}
                placeholder="Pegar código <iframe> o link directo aquí"
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
              />
              <p className="text-[10px] text-gray-500 mt-1">Este campo es el que se usa primordialmente en el visor integrado.</p>
            </div>

            {/* Optional external URL */}
            <div>
              <label className="block text-gray-400 font-medium mb-1.5">URL externa (opcional)</label>
              <input
                type="url"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder="https://ejemplo.com/catalogo.pdf"
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Priority & IsActive */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-400 font-medium mb-1.5">Prioridad de Carga (1 es max)</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 cursor-pointer text-gray-300 font-medium">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-[#0B0F19] text-blue-500 focus:ring-blue-500"
                  />
                  Documento Activo
                </label>
              </div>
            </div>

            <div>
              <label className="block text-gray-400 font-medium mb-1.5">Visibilidad</label>
              <select
                value={visibility}
                onChange={(e) => {
                  const nextVisibility = e.target.value;
                  setVisibility(nextVisibility);
                  setIsActive(nextVisibility === 'public');
                }}
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              >
                <option value="private">Borrador privado</option>
                <option value="public">Público</option>
              </select>
              <p className="text-[10px] text-gray-500 mt-1">
                Al publicar se activa el documento; al volverlo privado se retira de la biblioteca y del buscador.
              </p>
            </div>

            <div>
              <label className="block text-gray-400 font-medium mb-1.5">Tipo de publicación</label>
              <select
                value={publicationType}
                onChange={(e) => setPublicationType(e.target.value as 'catalog' | 'technical-sheet')}
                className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              >
                <option value="catalog">Catálogo</option>
                <option value="technical-sheet">Ficha técnica</option>
              </select>
            </div>

            {/* Category & Page Count */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="edit-document-category" className="block text-gray-400 font-medium mb-1.5">Categoría</label>
                <select
                  id="edit-document-category"
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">Selecciona una categoría</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.name}>{cat.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-gray-400 font-medium mb-1.5">Número de Páginas</label>
                <input
                  type="number"
                  min="1"
                  value={pageCount}
                  onChange={(e) => setPageCount(e.target.value)}
                  className="w-full bg-[#0B0F19] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  required
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3 pt-6 border-t border-white/10 mt-6 sticky bottom-0 bg-[#111827]">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/5 transition-colors font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors text-sm"
              >
                {isSubmitting ? 'Guardando...' : 'Guardar Cambios'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
