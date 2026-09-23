export function normalizeGoogleDriveLink(url: string | undefined | null): string | null {
  if (!url) return null;
  // Match the long file ID inside the drive link
  const match = url.match(/\/d\/([-\w]{25,})/);
  if (match && match[1]) {
    return `https://drive.google.com/file/d/${match[1]}/preview`;
  }
  return url;
}
