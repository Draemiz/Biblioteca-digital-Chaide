export function normalizeDestinationUrl(value: string | null | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;

  // Accept a plain domain entered by an administrator, while keeping explicit
  // application paths such as /viewer/ID internal.
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/:?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;

  // Do not render executable or unsupported protocols in an anchor.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return '';
  return `/${trimmed.replace(/^\/+/, '')}`;
}

export function isExternalDestinationUrl(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(normalizeDestinationUrl(value));
}
