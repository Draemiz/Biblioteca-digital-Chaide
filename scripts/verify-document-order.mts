import assert from 'node:assert/strict';
import { canFeature, homeDocument, savedDocumentOrder, uploadTime } from '../src/lib/documentOrder.ts';
import type { DocumentDef } from '../src/lib/mockData.ts';

const make = (id: string, extra: Partial<DocumentDef> = {}): DocumentDef => ({
  id, title: id, description: '', category: 'Descanso', pageCount: 1,
  coverUrl: '', fileUrl: '', tags: [], status: 'ready', ...extra,
});
const first = make('url-document', { order: 0, priority: 999 });
const second = make('upload-1700000000000-abc', { order: 1, priority: 0 });
assert.equal(homeDocument([second, first])?.id, first.id, 'Saved order wins over priority and upload source');
assert.equal(homeDocument([first, { ...second, isFeatured: true }])?.id, second.id, 'Explicit choice wins over order');
assert.equal(homeDocument([{ ...first, visibility: 'private', isFeatured: true }, second])?.id, second.id);
assert.equal(homeDocument([{ ...first, status: 'processing' }, second])?.id, second.id);
assert.equal(homeDocument([{ ...first, isActive: false }]), undefined);
assert.equal(canFeature({ ...first, visibility: 'private' }), false);
assert.deepEqual(savedDocumentOrder([second, first]).map((doc) => doc.id), [first.id, second.id]);
assert.equal(uploadTime(second), 1700000000000);
assert.equal(uploadTime(first), 0);
console.log('Document ordering and homepage selection checks passed.');
