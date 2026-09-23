import React from 'react';
import { Menu, Search } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useStore } from '../../store/useStore';

export default function Header() {
  const { toggleSidebar, searchQuery, setSearchQuery } = useStore();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery) {
      setSearchQuery(trimmedQuery);
      navigate(`/buscar?q=${encodeURIComponent(trimmedQuery)}`);
    }
  };

  const isViewerPage = location.pathname.startsWith('/viewer');
  const isSearchPage = location.pathname === '/buscar';

  return (
    <header className="library-header">
      <div className="library-header-main">
        <div className="library-header-left">
          <button 
            onClick={toggleSidebar}
            className="header-menu-button desktop-only"
            title="Menú"
          >
            <Menu size={22} strokeWidth={1.5} />
          </button>
          <a href="/" className="library-logo" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
            <strong>Chaide</strong>
            <span>Biblioteca Digital</span>
          </a>
        </div>

        <nav className="library-nav" aria-label="Navegación principal">
          <a href="/catalogos" onClick={(e) => { e.preventDefault(); navigate('/catalogos'); }}>Catálogos</a>
        </nav>

        <div className="library-actions">
          {!isSearchPage && (
            <form onSubmit={handleSearch} className="catalog-search desktop-search">
              <input 
                type="search" 
                placeholder="Buscar catálogos..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button type="submit" style={{ background: 'transparent', border: 'none', display: 'flex', justifyContent: 'center', cursor: 'pointer' }} aria-label="Buscar">
                <Search className="catalog-search-icon" size={18} />
              </button>
            </form>
          )}

          {isViewerPage && (
            <button
              type="button"
              onClick={() => navigate(searchQuery.trim()
                ? `/buscar?q=${encodeURIComponent(searchQuery.trim())}`
                : '/buscar')}
              className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white"
              aria-label="Buscar en toda la biblioteca"
              title="Buscar en toda la biblioteca"
            >
              <Search size={19} />
            </button>
          )}

        </div>
      </div>
      
      {/* Mobile only search bar below the top bar */}
      {!isSearchPage && !isViewerPage && (
        <div className="mobile-search-container">
          <form onSubmit={handleSearch} className="catalog-search-mobile">
            <button type="submit" className="catalog-search-icon-button-mobile" aria-label="Buscar">
              <Search className="catalog-search-icon-mobile" size={18} />
            </button>
            <input 
              type="search" 
              placeholder="Buscar catálogos..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </form>
        </div>
      )}
    </header>
  );
}
