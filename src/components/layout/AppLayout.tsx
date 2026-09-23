import React, { useEffect, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import SidebarDrawer from './SidebarDrawer';
import Header from './Header';
import MobileBottomNav from './MobileBottomNav';
import CatalogAssistant from '../assistant/CatalogAssistant';
import { useStore, refreshPublicLibrary } from '../../store/useStore';
import { isFirebaseSite, isStaticSite } from '../../lib/runtimeConfig';

export default function AppLayout() {
  const requestedCategoriesRef = useRef(false);
  const requestedPromotionalBannerRef = useRef(false);
  const requestedDocumentsModeRef = useRef<string | null>(null);
  const {
    isSidebarOpen,
    role,
    documents,
    categories,
    isLoadingDocs,
    hasLoadedDocs,
    fetchDocuments,
    fetchCategories,
    fetchPromotionalBanner,
    hasLoadedPromotionalBanner,
    syncDocuments,
    setDocumentsSyncStatus,
  } = useStore();

  useEffect(() => {
    if (isStaticSite) return;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.hidden || pending || useStore.getState().isLoadingDocs) return;
      pending = true;
      try {
        await refreshPublicLibrary(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      } catch {
        // Keep the current page intact during temporary connection failures.
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  // A refreshed store (including development hot updates) needs fresh requests.
  // Component refs can survive that refresh while the store data is reset.
  useEffect(() => {
    requestedCategoriesRef.current = false;
    requestedPromotionalBannerRef.current = false;
    requestedDocumentsModeRef.current = null;
  }, [fetchCategories, fetchPromotionalBanner, fetchDocuments]);

  useEffect(() => {
    if (!isFirebaseSite) return undefined;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    setDocumentsSyncStatus('syncing');

    void import('../../lib/firebaseCatalog')
      .then(({ subscribeFirebaseDocuments }) => subscribeFirebaseDocuments(
        role === 'admin',
        (nextDocuments) => {
          if (!disposed) syncDocuments(nextDocuments);
        },
        () => {
          if (!disposed) setDocumentsSyncStatus('error');
        },
      ))
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch(() => {
        if (!disposed) {
          setDocumentsSyncStatus('error');
          void fetchDocuments(role === 'admin');
        }
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [role, setDocumentsSyncStatus, syncDocuments]);

  useEffect(() => {
    if (!requestedCategoriesRef.current && categories.length === 0) {
      requestedCategoriesRef.current = true;
      fetchCategories(role === 'admin');
    }

    if (!requestedPromotionalBannerRef.current && !hasLoadedPromotionalBanner) {
      requestedPromotionalBannerRef.current = true;
      fetchPromotionalBanner();
    }

    const documentsMode = role === 'admin' ? 'admin' : 'public';
    const shouldLoadDocuments =
      !isFirebaseSite &&
      !isLoadingDocs &&
      !hasLoadedDocs &&
      documents.length === 0 &&
      requestedDocumentsModeRef.current !== documentsMode;

    if (shouldLoadDocuments) {
      requestedDocumentsModeRef.current = documentsMode;
      fetchDocuments(role === 'admin');
    }
  }, [
    categories.length,
    documents.length,
    fetchCategories,
    fetchDocuments,
    fetchPromotionalBanner,
    hasLoadedDocs,
    hasLoadedPromotionalBanner,
    isLoadingDocs,
    role,
  ]);

  return (
    <div className={`page-shell layout-with-sidebar ${isSidebarOpen ? 'sidebar-expanded' : ''}`}>
      <Header />
      <SidebarDrawer />
      
      <main className="main-content">
        <Outlet />
      </main>
      
      <MobileBottomNav />
      <CatalogAssistant />
    </div>
  );
}
