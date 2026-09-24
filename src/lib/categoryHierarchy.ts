import { catalogCategories } from './catalogCategories';

type CategoryNode = { id: string; parentId?: string | null; active?: boolean };
export function categoryBranch<T extends CategoryNode>(categories: T[], id: string): T[] {
  const found: T[] = [];
  const visited = new Set<string>();
  const visit = (target: string) => {
    if (visited.has(target)) return;
    visited.add(target);
    const node = categories.find((item) => item.id === target && item.active !== false);
    if (!node) return;
    found.push(node);
    categories.filter((item) => item.parentId === target).forEach((item) => visit(item.id));
  };
  visit(id);
  return found;
}

// One-time, non-destructive upgrade of the original local category structure.
export function migrateCategoryHierarchy(db: any) {
  if (db.categoryHierarchyVersion === 1) return false;
  db.categories ||= [];
  for (const base of catalogCategories) {
    let existing = db.categories.find((item: any) => item.slug === base.slug);
    if (!existing && base.slug === 'fichas-de-productos-e-innovaciones') {
      existing = db.categories.find((item: any) => item.slug === 'fichas-de-productos');
      if (existing) {
        for (const document of db.documents || []) {
          if (document.category === existing.name || document.category === existing.slug) document.category = base.label;
        }
      }
    }
    if (!existing) { existing = { id: `catalog-${base.slug}` }; db.categories.push(existing); }
    Object.assign(existing, { name: base.label, slug: base.slug, description: base.description, icon: base.icon, order: base.order, displayOrder: base.order, parentId: null, active: true });
  }
  const product = db.categories.find((item: any) => item.slug === 'catalogo-de-productos');
  for (const category of db.categories) {
    if (['descanso', 'muebles', 'complementos', 'hoteles', 'espumas'].includes(category.slug)) category.parentId = product.id;
  }
  db.categoryHierarchyVersion = 1;
  return true;
}
