import React, { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, HashRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { ReactLenis } from 'lenis/react';
import AppLayout from './components/layout/AppLayout';
import { isFirebaseSite, isStaticSite } from './lib/runtimeConfig';
import { ADMIN_BASE_PATH } from './lib/adminRoutes';
import { useStore } from './store/useStore';

const LibraryHome = lazy(() => import('./pages/LibraryHome'));
const ViewerPage = lazy(() => import('./pages/ViewerPage'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const SearchResultsPage = lazy(() => import('./pages/SearchResultsPage'));
const CategoryPage = lazy(() => import('./pages/CategoryPage'));
const CategoriesPage = lazy(() => import('./pages/CategoriesPage'));
const AllCatalogsPage = lazy(() => import('./pages/AllCatalogsPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));

function RouteFallback() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center text-[#111]/50">
      <div className="w-8 h-8 rounded-full border-2 border-[#111]/15 border-t-[#111] animate-spin" />
    </div>
  );
}

function NotFoundPage() {
  return (
    <main className="min-h-screen bg-[#f5f4f0] px-6 py-16 text-[#111] flex items-center justify-center">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#e2231a]">Error 404</p>
        <h1 className="mt-4 text-3xl font-bold">Página no encontrada</h1>
        <p className="mt-3 text-sm text-[#111]/60">
          La dirección solicitada no existe o dejó de estar disponible.
        </p>
        <a
          href="/"
          className="mt-8 inline-flex rounded-full bg-[#111] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#e2231a]"
        >
          Volver al inicio
        </a>
      </div>
    </main>
  );
}

function FirebaseAuthBootstrap({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(!isFirebaseSite);
  const location = useLocation();
  const login = useStore((state) => state.login);
  const logout = useStore((state) => state.logout);

  useEffect(() => {
    if (!isFirebaseSite) return;
    let unsubscribe: () => void = () => {};
    let active = true;

    Promise.all([
      import('firebase/auth'),
      import('./lib/firebase'),
      import('./lib/firebaseCatalog'),
    ]).then(([firebaseAuth, firebase, catalog]) => {
      if (!active) return;
      unsubscribe = firebaseAuth.onAuthStateChanged(firebase.auth, (user) => {
        if (user && catalog.isFirebaseAdminEmail(user.email) && user.emailVerified) {
          login({
            id: user.uid,
            email: user.email || '',
            name: user.displayName || 'CHAIDE 2026',
            role: 'admin',
            avatarUrl: user.photoURL || undefined,
          });
        } else {
          logout();
        }
        setIsReady(true);
      });
    }).catch(() => {
      logout();
      setIsReady(true);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [login, logout]);

  // Authentication only protects the administrator. Public catalogue and
  // viewer routes must never wait for Firebase Auth: browsers that block or
  // delay its persistence callback were otherwise left on a white spinner.
  const requiresAuthenticatedBootstrap = location.pathname === ADMIN_BASE_PATH;
  return !requiresAuthenticatedBootstrap || isReady ? children : <RouteFallback />;
}

function InternalAdminApp() {
  const role = useStore((state) => state.role);
  return role === 'admin' ? <AdminDashboard /> : <LoginPage />;
}

function App() {
  const Router = isStaticSite ? HashRouter : BrowserRouter;
  const routerProps = isStaticSite
    ? {}
    : { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' };

  return (
    <ReactLenis root>
      <Router {...routerProps}>
        <FirebaseAuthBootstrap>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Main app wrapper with Sidebar */}
              <Route element={<AppLayout />}>
                <Route path="/" element={<LibraryHome />} />
                <Route path="/buscar" element={<SearchResultsPage />} />
                <Route path="/categoria/:slug" element={<CategoryPage />} />
                <Route path="/categorias" element={<CategoriesPage />} />
                <Route path="/catalogos" element={<AllCatalogsPage />} />
                <Route path="/acerca-de" element={<AboutPage />} />
                <Route path="/viewer/:id" element={<ViewerPage />} />
              </Route>

              {/* Internal administration is deliberately outside the public layout. */}
              <Route path={ADMIN_BASE_PATH} element={isStaticSite ? <Navigate to="/" replace /> : <InternalAdminApp />} />

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </FirebaseAuthBootstrap>
      </Router>
    </ReactLenis>
  );
}

export default App;
