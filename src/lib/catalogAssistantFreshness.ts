import type { CatalogAssistantSource } from './catalogAssistant';
import type { DocumentDef } from './mockData';

export function assistantDocumentVersion(document: DocumentDef) {
  return document.searchIndexVersion || document.fileUrl || 'current';
}

export function isAssistantDocumentEligible(document: DocumentDef) {
  return document.status === 'ready' &&
    document.isActive !== false &&
    document.visibility !== 'private' &&
    document.searchIndexStatus !== 'no-text' &&
    document.searchIndexStatus !== 'error';
}

/** Accepts a source only while its exact catalogue version remains public. */
export function filterCurrentAssistantSources(
  sources: CatalogAssistantSource[],
  documents: DocumentDef[],
) {
  const currentDocuments = new Map(
    documents.filter(isAssistantDocumentEligible).map((document) => [document.id, document]),
  );
  return sources.filter((source) => {
    const document = currentDocuments.get(source.catalogId);
    if (!document) return false;
    return source.indexVersion === assistantDocumentVersion(document) &&
      source.pageNumber >= 1 &&
      source.pageNumber <= Math.max(1, Number(document.pageCount || 0));
  });
}
