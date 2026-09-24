import assert from 'node:assert/strict';
import { documentMatchesCatalogCategory } from '../src/lib/catalogCategories.ts';
const catalogCategories = [{ label: 'Descanso', slug: 'descanso' }, { label: 'Muebles', slug: 'muebles' }, { label: 'Espumas', slug: 'espumas' }];
import type { DocumentDef } from '../src/lib/mockData.ts';

const document: DocumentDef = {
  id: 'test', title: 'Catálogo muebles y espumas', description: 'Colchones y sofás',
  category: 'Descanso', tags: ['espumas', 'muebles'], pageCount: 1, fileUrl: '', coverUrl: '',
};
assert.deepEqual(catalogCategories.filter(category => documentMatchesCatalogCategory(document, category)).map(category => category.slug), ['descanso']);
const custom = { name: 'Fichas de Productos', slug: 'fichas-de-productos' };
assert.equal(documentMatchesCatalogCategory({ ...document, category: custom.name }, custom), true);
assert.equal(documentMatchesCatalogCategory({ ...document, category: custom.name }, catalogCategories[0]), false);
assert.equal(documentMatchesCatalogCategory({ ...document, category: 'Muebles' }, catalogCategories[0]), false);
assert.equal(documentMatchesCatalogCategory({ ...document, category: 'Muebles' }, catalogCategories[1]), true);
console.log('Category assignment checks passed.');
