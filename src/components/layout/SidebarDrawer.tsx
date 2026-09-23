import { compareCategoryOrder } from '../../lib/catalogCategories';
import React, { useEffect, useState } from "react";
import { useStore } from "../../store/useStore";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  BookOpen,
} from "lucide-react";
import { getCategoryIconComponent } from "../../lib/categoryIconRegistry";

function CategoryIcon({ icon, imageUrl }: { icon?: string, imageUrl?: string }) {
  if (imageUrl) {
    return <img src={imageUrl} alt="" className="w-5 h-5 object-contain" />;
  }
  const Icon = getCategoryIconComponent(icon || "Tag");
  return <Icon className="w-5 h-5" />;
}

export default function SidebarDrawer() {
  const { isSidebarOpen, setSidebarOpen, categories } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close sidebar on mobile when navigating
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [location.pathname, isMobile, setSidebarOpen]);

  return (
    <>
      {isMobile && isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[90] backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`library-sidebar ${
          isSidebarOpen ? "is-expanded" : "is-collapsed"
        } ${isMobile && isSidebarOpen ? "is-open" : ""}`}
      >
        <nav className="sidebar-nav">
          <a
            className={`sidebar-item ${
              location.pathname === "/" ? "is-active" : ""
            }`}
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            <Home />
            <span>Inicio</span>
          </a>

          <a
            className={`sidebar-item ${
              location.pathname === "/catalogos" ? "is-active" : ""
            }`}
            href="/catalogos"
            onClick={(e) => {
              e.preventDefault();
              navigate("/catalogos");
            }}
          >
            <BookOpen />
            <span>Catálogos</span>
          </a>

          {categories
            .filter((category) => category.active !== false)
            .sort(compareCategoryOrder)
            .map((category) => (
              <a
                key={category.id}
                className={`sidebar-item ${
                  location.pathname === `/categoria/${category.slug}`
                    ? "is-active"
                    : ""
                }`}
                href={`/categoria/${category.slug}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/categoria/${category.slug}`);
                }}
              >
                <CategoryIcon icon={category.icon} imageUrl={category.imageUrl} />
                <span>{category.name}</span>
              </a>
            ))}
        </nav>
      </aside>
    </>
  );
}

