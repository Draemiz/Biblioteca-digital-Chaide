import assert from 'node:assert/strict';
import { categoryBranch, migrateCategoryHierarchy } from '../src/lib/categoryHierarchy.ts';
import { documentMatchesCatalogCategory } from '../src/lib/catalogCategories.ts';
const db: any = { categories: [
  { id: 'rest', name: 'Descanso', slug: 'descanso' },
  { id: 'sheets', name: 'Fichas de Productos', slug: 'fichas-de-productos' },
], documents: [{ id: 'a', category: 'Descanso' }, { id: 'b', category: 'Fichas de Productos' }] };
assert.equal(migrateCategoryHierarchy(db), true);
assert.equal(db.categories.filter((c: any) => !c.parentId).length, 5);
const product = db.categories.find((c: any) => c.slug === 'catalogo-de-productos');
const branch = categoryBranch(db.categories, product.id);
assert.equal(branch.some((c: any) => documentMatchesCatalogCategory(db.documents[0], c)), true);
assert.equal(branch.some((c: any) => documentMatchesCatalogCategory(db.documents[1], c)), false);
assert.equal(db.documents[1].category, 'Fichas de Productos e Innovaciones');
const snapshot = JSON.stringify(db);
assert.equal(migrateCategoryHierarchy(db), false);
assert.equal(JSON.stringify(db), snapshot);
assert.equal(categoryBranch([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], 'a').length, 2);
console.log('Hierarchy migration, isolation and cycle checks passed.');
