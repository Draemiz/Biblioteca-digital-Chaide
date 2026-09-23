import React, { useState } from 'react';
import { useStore, Category } from '../store/useStore';
import { Plus, Edit2, Trash2, Tag, Check, X } from 'lucide-react';

export default function AdminCategoriesPage() {
  const { categories, addCategory, updateCategory, removeCategory } = useStore();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  
  // Form State
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [iconKey, setIconKey] = useState('');
  const [order, setOrder] = useState<number>(0);
  const [isActive, setIsActive] = useState(true);

  const resetForm = () => {
    setName('');
    setSlug('');
    setDescription('');
    setIconKey('');
    setOrder(0);
    setIsActive(true);
    setEditingCategory(null);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const newCategory: Category = {
      id: editingCategory ? editingCategory.id : Math.random().toString(36),
      name,
      slug,
      description,
      icon: iconKey,
      order,
      active: isActive
    };

    if (editingCategory) {
      updateCategory(editingCategory.id, newCategory);
    } else {
      addCategory(newCategory);
    }
    setIsFormOpen(false);
    resetForm();
  };

  return (
    <main className="p-8">
      <header className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Categorías</h1>
          <p className="text-gray-400">Administra las categorías visibles.</p>
        </div>
        <button 
          onClick={() => setIsFormOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Crear categoría
        </button>
      </header>

      {isFormOpen && (
        <form onSubmit={handleSave} className="bg-white/5 border border-white/10 p-6 rounded-xl mb-8 space-y-4">
          <h2 className="text-xl font-bold">{editingCategory ? 'Editar' : 'Crear'} Categoría</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <input placeholder="Nombre" value={name} onChange={e => setName(e.target.value)} className="bg-black/20 p-2 rounded" required />
            <input placeholder="Slug" value={slug} onChange={e => setSlug(e.target.value)} className="bg-black/20 p-2 rounded" required />
            <input placeholder="Icon (lucide)" value={iconKey} onChange={e => setIconKey(e.target.value)} className="bg-black/20 p-2 rounded" />
            <input type="number" placeholder="Orden" value={order} onChange={e => setOrder(parseInt(e.target.value, 10))} className="bg-black/20 p-2 rounded" />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <input type="checkbox" id="isActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="rounded bg-black/20" />
            <label htmlFor="isActive">Activa</label>
          </div>
          <textarea placeholder="Descripción" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-black/20 p-2 rounded" />
          <div className="flex gap-2">
            <button type="submit" className="bg-blue-600 px-4 py-2 rounded">Guardar</button>
            <button type="button" onClick={() => { setIsFormOpen(false); resetForm(); }} className="bg-white/10 px-4 py-2 rounded">Cancelar</button>
          </div>
        </form>
      )}

      <div className="grid gap-4">
        {categories.map(cat => (
          <div key={cat.id} className="bg-white/5 p-4 rounded-lg flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Tag className="w-6 h-6 text-gray-500" />
              <div>
                <h3 className="font-bold flex items-center gap-2">
                  {cat.name}
                  {!cat.active ? (
                    <span className="text-xs bg-red-500/20 text-red-400 px-2 rounded">Inactiva</span>
                  ) : (
                    <span className="text-xs bg-green-500/20 text-green-400 px-2 rounded">Activa</span>
                  )}
                </h3>
                <p className="text-sm text-gray-400">/{cat.slug} · Orden: {cat.order || 0}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => {
                  setEditingCategory(cat);
                  setName(cat.name);
                  setSlug(cat.slug);
                  setDescription(cat.description || '');
                  setIconKey(cat.icon || '');
                  setOrder(cat.order || 0);
                  setIsActive(cat.active !== false); // default true if undefined
                  setIsFormOpen(true);
                }}
                className="p-2 hover:bg-white/10 rounded"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button onClick={() => removeCategory(cat.id)} className="p-2 hover:bg-red-500/20 rounded text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
