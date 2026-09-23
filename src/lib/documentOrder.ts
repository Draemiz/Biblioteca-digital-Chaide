import type { DocumentDef } from './mockData';

export const canFeature = (doc: DocumentDef) => doc.status === 'ready' && doc.isActive !== false && doc.visibility !== 'private';
export const savedDocumentOrder = (documents: DocumentDef[]) => [...documents].sort((a, b) =>
  (a.order ?? 999) - (b.order ?? 999) || (a.priority ?? 999) - (b.priority ?? 999));
export function homeDocument(documents: DocumentDef[]) {
  const published = savedDocumentOrder(documents).filter(canFeature);
  return published.find((doc) => doc.isFeatured) || published[0];
}

export function uploadTime(doc: DocumentDef) {
  const created = Date.parse((doc as DocumentDef & { createdAt?: string }).createdAt || '');
  return Number.isFinite(created) ? created : Number(doc.id.match(/(?:upload-)(\d{13})/)?.[1] || 0);
}
