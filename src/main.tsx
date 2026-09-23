import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// A tab can stay open while Firebase publishes a new set of hashed chunks.
// If that tab requests a chunk from the previous release, Vite emits this
// event. Reload once so the browser receives the current index and chunk map.
const PRELOAD_RECOVERY_KEY = 'chaide-preload-recovery';
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (sessionStorage.getItem(PRELOAD_RECOVERY_KEY)) return;
  sessionStorage.setItem(PRELOAD_RECOVERY_KEY, '1');
  const freshUrl = new URL(window.location.href);
  freshUrl.searchParams.set('_appv', Date.now().toString(36));
  window.location.replace(freshUrl.toString());
});

window.setTimeout(() => {
  sessionStorage.removeItem(PRELOAD_RECOVERY_KEY);
}, 10_000);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker only in production builds. In dev it would
// interfere with Vite's HMR, so it stays disabled there.
if ((import.meta as any).env?.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
