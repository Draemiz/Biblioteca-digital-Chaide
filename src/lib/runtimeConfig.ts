export const isStaticSite = import.meta.env.VITE_STATIC_SITE === 'true';

// Firebase Hosting serves the SPA from these domains. Keep this runtime
// fallback so a missing CI environment variable cannot silently deploy a
// server-mode build that calls /api/* and leaves the public library empty.
const hostname = typeof window === 'undefined' ? '' : window.location.hostname;
const isFirebaseHostingDomain =
  hostname === 'biblioteca-catalogos-chaide.web.app' ||
  hostname === 'biblioteca-catalogos-chaide.firebaseapp.com';

export const isFirebaseSite =
  import.meta.env.VITE_FIREBASE_SITE === 'true' || isFirebaseHostingDomain;

export function publicAssetUrl(url: string | null | undefined) {
  if (!url || !isStaticSite) return url || '';

  if (url.startsWith('/storage/')) {
    return `${import.meta.env.BASE_URL}${url.slice(1)}`;
  }

  return url;
}

export function staticDataUrl(fileName: string) {
  return `${import.meta.env.BASE_URL}static-data/${fileName}`;
}
