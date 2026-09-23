import { compareCategoryOrder } from '../../lib/catalogCategories';
import React, { useState, useEffect } from 'react';
import { useStore, Category } from '../../store/useStore';
import { isFirebaseSite } from '../../lib/runtimeConfig';
import { 
  Plus, Edit2, Trash2, Tag, X, Check,
} from 'lucide-react';
import {
  CATEGORY_ICON_COMPONENTS,
  CATEGORY_ICON_OPTIONS,
  getCategoryIconComponent,
} from '../../lib/categoryIconRegistry';
import { catalogCategories } from '../../lib/catalogCategories';

const BASE_CATEGORY_SLUGS = new Set<string>(catalogCategories.map((category) => category.slug));

function IconPicker({ selected, onSelect }: { selected: string, onSelect: (key: string) => void }) {
  return (
    <div className="grid grid-cols-6 sm:grid-cols-8 gap-2 mt-2 max-h-40 overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-white/10">
      {CATEGORY_ICON_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onSelect(opt.key)}
          className={`p-2.5 rounded-xl flex items-center justify-center transition-all ${
            selected === opt.key 
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40 scale-105 z-10' 
              : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
          }`}
          title={opt.key}
        >
          <opt.icon className="w-5 h-5" />
        </button>
      ))}
    </div>
  );
}

export default function CategoryManager() {
  const { categories, addCategory, updateCategory, removeCategory } = useStore();
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  const reorder = async (sourceId: string, targetId: string) => {
    setDraggedId(null);
    setDropId(null);
    if (savingOrder || sourceId === targetId) return;
    const sorted = [...categories].sort(compareCategoryOrder);
    const source = sorted.findIndex((item) => item.id === sourceId);
    const target = sorted.findIndex((item) => item.id === targetId);
    if (source < 0 || target < 0) return;
    const [moved] = sorted.splice(source, 1);
    sorted.splice(target, 0, moved);
    const next = sorted.map((item, displayOrder) => ({ ...item, displayOrder }));
    setSavingOrder(true);
    setOrderMessage('Guardando orden…');
    try {
      if (isFirebaseSite) {
        const [{ writeBatch, doc }, { db }] = await Promise.all([import('firebase/firestore'), import('../../lib/firebase')]);
        const batch = writeBatch(db);
        next.forEach((item) => batch.update(doc(db, 'categories', item.id), { displayOrder: item.displayOrder }));
        await batch.commit();
      } else {
        for (const item of next) {
          const response = await fetch(`/api/categories/${encodeURIComponent(item.id)}`, {
            method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayOrder: item.displayOrder }),
          });
          if (!response.ok) throw new Error('No se pudo completar el orden. Inténtalo de nuevo.');
        }
      }
      useStore.setState({ categories: next });
      setOrderMessage('Orden guardado. La web se actualizará automáticamente.');
    } catch (error) {
      await useStore.getState().fetchCategories(true);
      setOrderMessage(error instanceof Error ? error.message : 'No se pudo guardar el orden.');
    } finally { setSavingOrder(false); }
  };
  
  // Form State
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [iconKey, setIconKey] = useState('Tag');
  const [imageUrl, setImageUrl] = useState('');
  const [order, setOrder] = useState(0);
  const isEditingBaseCategory = editingCategory ? BASE_CATEGORY_SLUGS.has(editingCategory.slug) : false;

  useEffect(() => {
    if (editingCategory) {
      setName(editingCategory.name);
      setSlug(editingCategory.slug);
      setDescription(editingCategory.description || '');
      setIconKey(editingCategory.icon || '');
      setImageUrl(editingCategory.imageUrl || '');
      setOrder(editingCategory.order || 0);
      setIsFormOpen(true);
    }
  }, [editingCategory]);

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('icon', file);

    try {
      const res = await fetch('/api/categories/upload-icon', {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const { imageUrl: uploadedUrl } = await res.json();
        setImageUrl(uploadedUrl);
        setIconKey(''); // Preferred image over icon
      }
    } catch (err) {
      console.error(err);
      alert('Error al subir el icono');
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !slug) return;
    
    const catData = {
      name,
      slug,
      description,
      icon: iconKey,
      imageUrl,
      order: editingCategory ? order : Math.max(50, ...categories.map((category) => category.order ?? 0)) + 1,
    } as Category;

    if (editingCategory) {
      await updateCategory(editingCategory.id, catData);
    } else {
      await addCategory(catData);
    }
    
    resetForm();
  };

  const resetForm = () => {
    setEditingCategory(null);
    setName('');
    setSlug('');
    setDescription('');
    setIconKey('Tag');
    setImageUrl('');
    setOrder(0);
    setIsFormOpen(false);
  };

  const getIconComponent = (cat: Category) => {
    if (cat.imageUrl) {
      return <img src={cat.imageUrl} alt={cat.name} className="w-5 h-5 object-contain" />;
    }
    const IconComp = getCategoryIconComponent(cat.icon || 'Tag');
    return <IconComp className="w-5 h-5" />;
  };

  const getPreviewIcon = () => {
    if (imageUrl) {
      return <img src={imageUrl} alt="Preview" className="w-full h-full object-contain p-1" />;
    }
    const IconComp = CATEGORY_ICON_COMPONENTS[iconKey || 'Tag'] || Tag;
    return <IconComp className="w-6 h-6" />;
  };

  return (
    <div className="bg-[#111827] border border-white/10 rounded-2xl overflow-hidden mt-8 text-white">
      <div className="p-6 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <div>
          <h2 className="text-xl font-bold">Gestión de Categorías</h2>
          <p className="text-sm text-gray-500 mt-1">Organiza tus catálogos por temas o colecciones</p>
        </div>
        {!isFormOpen && (
          <button 
            onClick={() => setIsFormOpen(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all"
          >
            <Plus className="w-4 h-4" /> Nueva Categoría
          </button>
        )}
      </div>
      
      {isFormOpen && (
        <div className="p-6 bg-white/[0.04] border-b border-white/5">
          <form onSubmit={handleSave} className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-white">
                {editingCategory ? 'Editar Categoría' : 'Nueva Categoría'}
              </h3>
              <button type="button" onClick={resetForm} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Nombre</label>
                    <input 
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (!editingCategory) setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'));
                      }}
                      placeholder="Ej: Colchones Premium"
                      className="w-full bg-[#0B0F19] border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Slug (URL)</label>
                    <input 
                      type="text"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      disabled={isEditingBaseCategory}
                      placeholder="colchones-premium"
                      className="w-full bg-[#0B0F19] border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    {isEditingBaseCategory && (
                      <p className="text-[10px] text-gray-500 mt-1.5">
                        Esta ruta pertenece a una categoria base del catalogo.
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-end mb-1.5">
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">Icono Predeterminado</label>
                    {imageUrl && (
                      <button 
                        type="button"
                        onClick={() => { setImageUrl(''); setIconKey('Tag'); }} 
                        className="text-[10px] text-blue-400 hover:underline"
                      >
                        Usar iconos Lucide
                      </button>
                    )}
                  </div>
                  <IconPicker selected={imageUrl ? '' : iconKey} onSelect={(key) => { setIconKey(key); setImageUrl(''); }} />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Descripción (Opcional)</label>
                  <textarea 
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-[#0B0F19] border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Subir Icono Personalizado</label>
                  <div className="flex flex-col items-center p-6 bg-[#0B0F19] border-2 border-dashed border-white/10 rounded-2xl">
                    <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center text-blue-500 mb-4 border border-white/5">
                      {getPreviewIcon()}
                    </div>
                    <label className="cursor-pointer bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 px-4 py-2 rounded-lg text-xs font-bold transition-all">
                      {isUploading ? 'Subiendo...' : 'Seleccionar Archivo'}
                      <input type="file" className="hidden" accept="image/png, image/jpeg, image/svg+xml" onChange={handleIconUpload} disabled={isUploading} />
                    </label>
                    <p className="text-[10px] text-gray-500 mt-3 text-center">
                      Formatos: <span className="text-gray-400 font-medium">SVG, PNG o JPG</span><br/>
                      Tamaño recomendado: <span className="text-gray-400 font-medium">64x64px</span>
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Orden de Visualización</label>
                  <input 
                    type="number"
                    value={order}
                    onChange={(e) => setOrder(parseInt(e.target.value, 10))}
                    className="w-full bg-[#0B0F19] border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-white/5">
              <button 
                type="button" 
                onClick={resetForm}
                className="px-6 py-2.5 rounded-xl text-sm font-bold text-gray-400 hover:text-white transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="submit"
                className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-blue-600/20 flex items-center gap-2"
              >
                <Check className="w-4 h-4" /> {editingCategory ? 'Guardar Cambios' : 'Crear Categoría'}
              </button>
            </div>
          </form>
        </div>
      )}
      
      <div className="p-6">
        <p className="mb-3 text-sm text-gray-400">Arrastra una categoría sobre otra para cambiar su posición. El orden se guarda al soltar.</p>
        {orderMessage && <p role="status" className="mb-3 text-sm text-blue-200">{orderMessage}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...categories].sort(compareCategoryOrder).map(cat => {
            const isBaseCategory = BASE_CATEGORY_SLUGS.has(cat.slug);

            return (
            <div key={cat.id} draggable={!savingOrder && !isFormOpen}
              onDragStart={(event) => { setDraggedId(cat.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', cat.id); }}
              onDragOver={(event) => { if (draggedId && !savingOrder) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropId(cat.id); } }}
              onDrop={(event) => { event.preventDefault(); if (draggedId) void reorder(draggedId, cat.id); }}
              onDragEnd={() => { setDraggedId(null); setDropId(null); }}
              className={`group bg-[#0B0F19] border p-4 rounded-2xl flex justify-between items-center transition-all ${savingOrder ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'} ${dropId === cat.id ? 'border-blue-400 ring-2 ring-blue-500/30' : 'border-white/5 hover:border-white/20'} ${draggedId === cat.id ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-500 group-hover:scale-110 transition-transform p-2">
                  {getIconComponent(cat)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-white group-hover:text-blue-400 transition-colors">{cat.name}</p>
                    {isBaseCategory && (
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                        Base
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">/{cat.slug}</p>
                </div>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => setEditingCategory(cat)} 
                  className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                  title="Editar"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                {!isBaseCategory && (
                  <button 
                    onClick={() => {
                      if (window.confirm(`¿Seguro que deseas eliminar la categoría "${cat.name}"?`)) {
                        removeCategory(cat.id);
                      }
                    }} 
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                    title="Eliminar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            );
          })}
          {categories.length === 0 && !isFormOpen && (
            <div className="col-span-full py-12 text-center">
              <Tag className="w-12 h-12 text-white/5 mx-auto mb-4" />
              <p className="text-gray-500">No hay categorías creadas aún.</p>
              <button 
                onClick={() => setIsFormOpen(true)}
                className="text-blue-500 hover:underline text-sm font-medium mt-2"
              >
                Crea la primera categoría
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

