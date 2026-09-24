import { create } from 'zustand';
import { DocumentDef } from '../lib/mockData';
import { isFirebaseSite, isStaticSite, publicAssetUrl, staticDataUrl } from '../lib/runtimeConfig';
import { normalizeDestinationUrl } from '../lib/linkUtils';

export type UserRole = 'guest' | 'user' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
}

const USER_STORAGE_KEY = 'chaide-digital-library-user';
let documentsRequestSequence = 0;

function staticWriteError() {
  return new Error('La administración no está disponible en la versión pública.');
}

function normalizePublicDocument(document: DocumentDef): DocumentDef {
  const sanitizeIndexItems = (items: NonNullable<DocumentDef['indexItems']>): NonNullable<DocumentDef['indexItems']> =>
    items.flatMap((item) => {
      const title = String(item.title || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const children = item.children ? sanitizeIndexItems(item.children) : undefined;
      if (title.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return children || [];
      return [{ ...item, title, children }];
    });
  return {
    ...document,
    coverUrl: publicAssetUrl(document.coverUrl),
    fileUrl: publicAssetUrl(document.fileUrl),
    externalUrl: publicAssetUrl(document.externalUrl),
    indexItems: document.indexItems ? sanitizeIndexItems(document.indexItems) : document.indexItems,
  };
}

function normalizePublicCategory(category: Category): Category {
  return {
    ...category,
    imageUrl: publicAssetUrl(category.imageUrl),
  };
}

function normalizePublicBanner(banner: PromotionalBannerConfig): PromotionalBannerConfig {
  return {
    ...banner,
    imageUrl: publicAssetUrl(banner.imageUrl),
    mobileImageUrl: publicAssetUrl(banner.mobileImageUrl),
    targetUrl: normalizeDestinationUrl(banner.targetUrl),
  };
}

function getStoredUser(): User | null {
  if (typeof window === 'undefined') return null;

  try {
    const rawUser = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!rawUser) return null;

    const parsedUser = JSON.parse(rawUser) as User;
    if (!parsedUser?.id || !parsedUser?.email || !parsedUser?.role) return null;
    return parsedUser;
  } catch {
    window.localStorage.removeItem(USER_STORAGE_KEY);
    return null;
  }
}

export interface Category {
  parentId?: string | null;
  displayOrder?: number;
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  imageUrl?: string;
  order?: number;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromotionalBannerConfig {
  imageUrl: string;
  /** Separate portrait image for mobile (~9:10, recommended 1700 x 1900). */
  mobileImageUrl?: string;
  mobileIsActive?: boolean;
  altText: string;
  targetUrl?: string;
  isActive: boolean;
  updatedAt?: string;
}

interface AppState {
  // Auth State
  user: User | null;
  role: UserRole;
  login: (user: User) => void;
  logout: () => void;
  
  // UI State
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (isOpen: boolean) => void;
  
  previewDocId: string | null;
  setPreviewDocId: (id: string | null) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Categories
  categories: Category[];
  fetchCategories: (isAdmin?: boolean) => Promise<void>;
  addCategory: (cat: Category) => void;
  updateCategory: (id: string, cat: Category) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;

  // Promotional banner
  promotionalBanner: PromotionalBannerConfig | null;
  hasLoadedPromotionalBanner: boolean;
  fetchPromotionalBanner: () => Promise<void>;
  updatePromotionalBanner: (banner: PromotionalBannerConfig) => Promise<void>;
  uploadPromotionalBannerImage: (file: File) => Promise<string>;

  // Documents
  documents: DocumentDef[];
  isLoadingDocs: boolean;
  hasLoadedDocs: boolean;
  documentsSyncStatus: 'idle' | 'syncing' | 'live' | 'error';
  fetchDocuments: (isAdmin?: boolean) => Promise<void>;
  syncDocuments: (documents: DocumentDef[]) => void;
  setDocumentsSyncStatus: (status: AppState['documentsSyncStatus']) => void;
  addDocument: (doc: DocumentDef) => void;
  updateDocument: (id: string, formData: FormData) => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
  updateDocumentStatus: (id: string, status: 'ready' | 'processing' | 'error') => void;
}

const storedUser = getStoredUser();

export async function refreshPublicLibrary(signal: AbortSignal) {
  if (isStaticSite) return;
  let documents: DocumentDef[], categories: Category[], banner: PromotionalBannerConfig | null;
  if (isFirebaseSite) {
    const catalog = await import('../lib/firebaseCatalog');
    [documents, categories, banner] = await Promise.all([
      catalog.fetchFirebaseDocuments(false), catalog.fetchFirebaseCategories(false), catalog.fetchFirebaseBanner(),
    ]);
  } else {
    const read = async (path: string) => {
      const response = await fetch(path, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo sincronizar la biblioteca');
      return response.json();
    };
    [documents, categories, banner] = await Promise.all([
      read('/api/documents'), read('/api/categories'), read('/api/promotional-banner'),
    ]);
  }
  if (signal.aborted) return;
  const next = {
    documents: documents.map(normalizePublicDocument),
    categories: categories.map(normalizePublicCategory),
    promotionalBanner: banner ? normalizePublicBanner(banner) : null,
  };
  // Retain object identity when nothing changed, avoiding unnecessary rerenders.
  useStore.setState((current) => ({
    documents: JSON.stringify(current.documents) === JSON.stringify(next.documents) ? current.documents : next.documents,
    categories: JSON.stringify(current.categories) === JSON.stringify(next.categories) ? current.categories : next.categories,
    promotionalBanner: JSON.stringify(current.promotionalBanner) === JSON.stringify(next.promotionalBanner) ? current.promotionalBanner : next.promotionalBanner,
    hasLoadedDocs: true, hasLoadedPromotionalBanner: true, documentsSyncStatus: 'live',
  }));
}

export const useStore = create<AppState>((set, get) => ({
  user: storedUser,

  role: storedUser?.role || 'guest',
  login: (user) => {
    const current = get();
    if (current.user?.id === user.id && current.role === user.role) return;
    documentsRequestSequence += 1;
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    set({
      user,
      role: user.role,
      documents: [],
      categories: current.categories.filter((category) => category.active !== false),
      isLoadingDocs: false,
      hasLoadedDocs: false,
      documentsSyncStatus: 'syncing',
    });
  },
  logout: () => {
    const current = get();
    if (!current.user && current.role === 'guest') return;
    documentsRequestSequence += 1;
    window.localStorage.removeItem(USER_STORAGE_KEY);
    // Never retain administrator-only drafts in memory after signing out.
    // The next public route performs a fresh rules-filtered Firestore query.
    set({
      user: null,
      role: 'guest',
      documents: [],
      categories: current.categories.filter((category) => category.active !== false),
      isLoadingDocs: false,
      hasLoadedDocs: false,
      documentsSyncStatus: 'syncing',
    });
  },
  
  isSidebarOpen: false,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),

  previewDocId: null,
  setPreviewDocId: (id) => set({ previewDocId: id }),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  categories: [],
  fetchCategories: async (isAdmin = false) => {
    try {
      if (isFirebaseSite) {
        const { fetchFirebaseCategories } = await import('../lib/firebaseCatalog');
        const firebaseCategories = await fetchFirebaseCategories(isAdmin);
        if (firebaseCategories.length) {
          set({ categories: firebaseCategories });
          return;
        }
      }
      const res = await fetch(isStaticSite || isFirebaseSite ? staticDataUrl('categories.json') : '/api/categories');
      if (res.ok) {
        const data = await res.json();
        set({ categories: data.map(normalizePublicCategory) });
      }
    } catch (e) {
      console.error(e);
    }
  },
  addCategory: async (cat) => {
    if (isStaticSite) throw staticWriteError();
    cat = { ...cat, order: Math.max(50, ...get().categories.map((item) => item.order ?? 0)) + 1 };
    if (isFirebaseSite) {
      const { saveFirebaseCategory } = await import('../lib/firebaseCatalog');
      const id = cat.id || cat.slug || `category-${Date.now().toString(36)}`;
      const newCategory = { ...cat, id, active: cat.active !== false };
      await saveFirebaseCategory(id, newCategory);
      set((state) => ({ categories: [...state.categories, newCategory] }));
      return;
    }
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cat)
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo guardar la categoría.');
      if (res.ok) {
        const newCat = await res.json();
        set((state) => ({ categories: [...state.categories, newCat] }));
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  },
  updateCategory: async (id, cat) => {
    if (isStaticSite) throw staticWriteError();
    if (isFirebaseSite) {
      const { saveFirebaseCategory } = await import('../lib/firebaseCatalog');
      const updatedCategory = { ...cat, id, active: cat.active !== false };
      await saveFirebaseCategory(id, updatedCategory);
      set((state) => ({
        categories: state.categories.map((item) => item.id === id ? updatedCategory : item),
      }));
      return;
    }
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cat)
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo guardar la categoría.');
      if (res.ok) {
        const updatedCat = await res.json();
        set((state) => ({ categories: state.categories.map(c => c.id === id ? updatedCat : c) }));
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  },
  removeCategory: async (id) => {
    if (isStaticSite) throw staticWriteError();
    if (isFirebaseSite) {
      const { deleteFirebaseCategory } = await import('../lib/firebaseCatalog');
      await deleteFirebaseCategory(id);
      set((state) => ({ categories: state.categories.filter((item) => item.id !== id) }));
      return;
    }
    try {
      const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      if (res.ok) {
        set((state) => ({ categories: state.categories.filter(c => c.id !== id) }));
      }
    } catch (e) {
      console.error(e);
    }
  },

  promotionalBanner: null,
  hasLoadedPromotionalBanner: false,
  fetchPromotionalBanner: async () => {
    try {
      if (isFirebaseSite) {
        const { fetchFirebaseBanner } = await import('../lib/firebaseCatalog');
        const firebaseBanner = await fetchFirebaseBanner();
        if (firebaseBanner) {
          set({
            promotionalBanner: normalizePublicBanner(firebaseBanner),
            hasLoadedPromotionalBanner: true,
          });
          return;
        }
      }
      const res = await fetch(isStaticSite || isFirebaseSite ? staticDataUrl('promotional-banner.json') : '/api/promotional-banner');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ promotionalBanner: normalizePublicBanner(data), hasLoadedPromotionalBanner: true });
    } catch (e) {
      console.error(e);
      set({ hasLoadedPromotionalBanner: true });
    }
  },
  updatePromotionalBanner: async (banner) => {
    if (isStaticSite) throw staticWriteError();
    if (isFirebaseSite) {
      const { saveFirebaseBanner } = await import('../lib/firebaseCatalog');
      const normalizedBanner = normalizePublicBanner(banner);
      await saveFirebaseBanner(normalizedBanner);
      set({ promotionalBanner: normalizedBanner, hasLoadedPromotionalBanner: true });
      return;
    }
    try {
      const res = await fetch('/api/promotional-banner', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(banner),
      });
      if (!res.ok) throw new Error(await res.text());
      const updatedBanner = await res.json();
      set({ promotionalBanner: updatedBanner, hasLoadedPromotionalBanner: true });
    } catch (e) {
      console.error(e);
      throw e;
    }
  },
  uploadPromotionalBannerImage: async (file) => {
    if (isStaticSite) throw staticWriteError();
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch('/api/promotional-banner/upload-image', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.imageUrl;
  },

  documents: [], // Loaded from API
  isLoadingDocs: false,
  hasLoadedDocs: false,
  documentsSyncStatus: 'idle',
  fetchDocuments: async (isAdmin = false, retries = 3) => {
    if (get().isLoadingDocs) {
      if (!isAdmin) return;
      // The app can begin a public fetch while Firebase is still restoring the
      // signed-in administrator. Never discard the subsequent admin refresh,
      // otherwise private drafts remain hidden until a manual reload.
      for (let attempt = 0; attempt < 100 && get().isLoadingDocs; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (get().isLoadingDocs) return;
    }
    const requestSequence = ++documentsRequestSequence;
    set({ isLoadingDocs: true, documentsSyncStatus: 'syncing' });
    
    const apiUrl = isStaticSite || isFirebaseSite
      ? staticDataUrl('documents.json')
      : `${window.location.origin}/api/documents${isAdmin ? '?admin=true' : ''}`;

    for (let i = 0; i < retries; i++) {
        try {
          if (isFirebaseSite) {
            const { fetchFirebaseDocuments } = await import('../lib/firebaseCatalog');
            const firebaseDocuments = await fetchFirebaseDocuments(isAdmin);
            if (requestSequence !== documentsRequestSequence) return;
            set({
              documents: firebaseDocuments.map(normalizePublicDocument),
              isLoadingDocs: false,
              hasLoadedDocs: true,
              documentsSyncStatus: 'live',
            });
            return;
          }
          console.log(`[Store] Attempt ${i + 1}: Fetching ${apiUrl}`);
          const res = await fetch(apiUrl, {
            signal: AbortSignal.timeout(15000),
            headers: {
              'Accept': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });

          // A remembered admin role can outlive the server session cookie.
          // Clear that stale identity and load the public library immediately.
          if (isAdmin && !isStaticSite && !isFirebaseSite && res.status === 401) {
            if (requestSequence !== documentsRequestSequence) return;
            get().logout();
            await get().fetchDocuments(false);
            return;
          }
          
          if (!res.ok) {
            const errorText = await res.text().catch(() => 'No error body');
            throw new Error(`Server returned ${res.status}: ${res.statusText}. Body: ${errorText}`);
          }
          
          const data = (await res.json()).map(normalizePublicDocument);
          console.log(`[Store] Attempt ${i + 1}: Success! Loaded ${data.length} documents.`);
          if (requestSequence !== documentsRequestSequence) return;
          set({ documents: data, isLoadingDocs: false, hasLoadedDocs: true, documentsSyncStatus: 'live' });

          // Aggressively preload PDFs + warm search indexes in the background so
          // catalogs open instantly once the user clicks, and search is ready
          // before they even enter the viewer. PDF loading is prioritized over
          // home-page lightness, as requested.
          if (!isAdmin && !isStaticSite && !isFirebaseSite) {
            import('../lib/pdfPrefetch')
              .then((m) => m.startGlobalPdfPrefetch(data))
              .catch(() => undefined);
          }
          return;
        } catch (e: any) {
          console.error(`[Store] Attempt ${i + 1} failed:`, e.name, e.message);
          if (i === retries - 1) {
            if (requestSequence === documentsRequestSequence) {
              set({ isLoadingDocs: false, hasLoadedDocs: true });
              set({ documentsSyncStatus: 'error' });
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)));
          }
        }
    }
  },
  syncDocuments: (documents) => set({
    documents: documents.map(normalizePublicDocument),
    isLoadingDocs: false,
    hasLoadedDocs: true,
    documentsSyncStatus: 'live',
  }),
  setDocumentsSyncStatus: (documentsSyncStatus) => set({ documentsSyncStatus }),
  
  addDocument: (doc) => set((state) => ({
    // Firestore refreshes and optimistic publication can finish almost at the
    // same time. Keep one in-memory row per id so replacement selects never
    // show the same catalogue twice even though Firestore itself is unique.
    documents: [doc, ...state.documents.filter((item) => item.id !== doc.id)],
  })),
  
  updateDocument: async (id, formData) => {
    if (isStaticSite) throw staticWriteError();
    try {
      const res = await fetch(`/api/documents/${id}`, {
        method: 'PUT',
        body: formData
      });
      if (!res.ok) throw new Error('No se pudieron guardar los cambios del documento.');
      if (res.ok) {
        const updatedDoc = await res.json();
        set((state) => ({
          documents: state.documents.map(d => d.id === id ? updatedDoc : d)
        }));
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  },

  removeDocument: async (id) => {
    if (isStaticSite) throw staticWriteError();
    // Optimistic update
    const previousDocs = get().documents;
    set((state) => ({ 
      documents: state.documents.filter(d => d.id !== id) 
    }));

    try {
      console.log(`[Store] Requesting deletion of document: ${id}`);
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      
      if (!res.ok) {
        const errText = await res.text().catch(() => 'No error body');
        throw new Error(`Server failed to delete: ${res.status} ${res.statusText}. ${errText}`);
      }
      
      const data = await res.json();
      console.log(`[Store] Deletion successful for document: ${id}`, data);
    } catch (e: any) {
      console.error(`[Store] Error deleting document ${id}:`, e.message);
      alert(`No se pudo eliminar el documento: ${e.message}`);
      // Rollback
      set({ documents: previousDocs });
      throw e;
    }
  },
  updateDocumentStatus: (id, status) => set((state) => ({
    documents: state.documents.map(d => d.id === id ? { ...d, status } : d)
  })),
}));
