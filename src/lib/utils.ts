import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function safeString(value: any): string {
  return typeof value === "string" ? value : "";
}

export function startsWithSafe(value: any, prefix: string): boolean {
  return typeof value === "string" && value.startsWith(prefix);
}

export function getSafeUrl(url: any): string {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('/')) return window.location.origin + url;
  return url;
}
