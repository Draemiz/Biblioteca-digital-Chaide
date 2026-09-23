import { compareCategoryOrder } from '../../lib/catalogCategories';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { motion } from 'motion/react';
import type { DocumentDef } from '../../lib/mockData';
import { catalogCategories, normalizeCatalogText } from '../../lib/catalogCategories';
import { useStore } from '../../store/useStore';
import { getCategoryIconComponent } from '../../lib/categoryIconRegistry';
import { prefetchPdfDocument } from '../../lib/pdfPrefetch';

interface EditorialHeroProps {
  doc: DocumentDef;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener?.('change', handleChange);
    return () => mediaQuery.removeEventListener?.('change', handleChange);
  }, [query]);

  return matches;
}

function cleanText(value: string | null | undefined, fallback = '') {
  return (value || '').replace(/\s+/g, ' ').trim() || fallback;
}

function toDisplayCase(value: string) {
  const text = cleanText(value);
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const isUpperCaseTitle = letters.length > 0 && letters === letters.toLocaleUpperCase('es-EC');

  if (!isUpperCaseTitle) return text;

  const smallWords = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'para']);

  return text
    .toLocaleLowerCase('es-EC')
    .split(' ')
    .map((word, index) => {
      if (index > 0 && smallWords.has(word)) return word;
      return word.charAt(0).toLocaleUpperCase('es-EC') + word.slice(1);
    })
    .join(' ');
}

function splitHeroTitle(title: string) {
  const words = cleanText(title, 'Catalogo').split(' ').filter(Boolean);

  if (words.length <= 2) return [words.join(' ')];
  if (words.length <= 4) return [words.slice(0, -1).join(' '), words.slice(-1).join(' ')];

  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')];
}

function getHeroCategoryLabel(doc: DocumentDef, categories: ReturnType<typeof useStore.getState>['categories']) {
  const contentText = normalizeCatalogText([
    doc.title,
    doc.description,
    ...(doc.tags || []),
    ...((doc.indexItems || []).map((item: any) => item?.title || '')),
  ].filter(Boolean).join(' '));

  const matchedStaticCategory = catalogCategories.find((category) =>
    category.keywords.some((keyword) => contentText.includes(normalizeCatalogText(keyword)))
  );
  const editableCategory =
    categories.find((category) => category.slug === matchedStaticCategory?.slug) ||
    categories.find((category) => normalizeCatalogText(category.name) === normalizeCatalogText(doc.category || ''));

  return editableCategory?.name || matchedStaticCategory?.label || cleanText(doc.category, 'Catalogo');
}

function HeroCoverImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div
        className="catalog-cover-image catalog-cover-image--placeholder"
        aria-label={alt}
        style={{
          width: '100%',
          height: '100%',
          background: 'linear-gradient(160deg, #111 0%, #2a2a2a 50%, #3a3a3a 100%)',
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="catalog-cover-image"
      onError={() => setFailed(true)}
    />
  );
}

export default function EditorialHero({ doc }: EditorialHeroProps) {
  const navigate = useNavigate();
  const { categories } = useStore();
  // Keep the React layout mode on the same viewport breakpoints as the CSS.
  // Observing the hero's own width caused a feedback loop near tablet/mobile:
  // changing the class changed the measured width, which changed the class
  // again and made the cover flicker while the browser was being resized.
  const isShortViewport = useMediaQuery('(max-height: 559px) and (min-width: 651px)');
  const isMobileViewport = useMediaQuery('(max-width: 768px)');
  const isCompactViewport = useMediaQuery('(min-width: 769px) and (max-width: 1180px)');
  const categoryRailDragRef = useRef({
    pointerId: -1,
    startY: 0,
    startScrollTop: 0,
    moved: false,
  });
  const suppressCategoryClickRef = useRef(false);

  const isShort = isShortViewport;
  const isMobile = isMobileViewport && !isShort;
  const isCompact = isCompactViewport && !isShort;

  const heroMode = isShort
    ? 'short'
    : isMobile
      ? 'mobile'
      : isCompact
        ? 'compact'
        : 'desktop';

  const displayTitle = toDisplayCase(cleanText(doc.title, 'Catalogo destacado'));
  const titleLines = splitHeroTitle(displayTitle);
  const categoryLabel = getHeroCategoryLabel(doc, categories);
  const heroCategories = useMemo(() => {
    const editableCategories = [...categories]
      .filter((category) => category.active !== false)
      .sort(compareCategoryOrder);

    if (editableCategories.length > 0) return editableCategories;

    return catalogCategories.map((category) => ({
      id: `catalog-${category.slug}`,
      name: category.label,
      slug: category.slug,
      description: category.description,
      icon: category.icon,
      order: category.order,
      active: true,
    }));
  }, [categories]);
  const year = displayTitle.match(/\b(20\d{2})\b/)?.[1];
  const pageCountLabel = doc.pageCount ? `${doc.pageCount} paginas` : '';
  const coverMeta = [year ? `Catalogo ${year}` : 'Catalogo digital', pageCountLabel].filter(Boolean).join(' / ');
  const description = cleanText(
    doc.description,
    `Explora ${displayTitle} en la biblioteca digital de Chaide.`
  );

  useEffect(() => {
    const requestIdle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const cancelIdle = (window as Window & {
      cancelIdleCallback?: (id: number) => void;
    }).cancelIdleCallback;

    if (requestIdle) {
      const idleId = requestIdle(() => prefetchPdfDocument(doc), { timeout: 2500 });
      return () => cancelIdle?.(idleId);
    }

    const timer = window.setTimeout(() => prefetchPdfDocument(doc), 1800);
    return () => window.clearTimeout(timer);
  }, [doc]);

  const handleCategoryRailPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0) return;

    const rail = event.currentTarget;
    if (rail.scrollHeight <= rail.clientHeight) return;

    categoryRailDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: rail.scrollTop,
      moved: false,
    };
    suppressCategoryClickRef.current = false;
    rail.setPointerCapture(event.pointerId);
    rail.classList.add('is-dragging');
  };

  const handleCategoryRailPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = categoryRailDragRef.current;
    if (drag.pointerId !== event.pointerId) return;

    const distance = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(distance) >= 5) {
      drag.moved = true;
      suppressCategoryClickRef.current = true;
    }

    if (drag.moved) {
      event.preventDefault();
      event.currentTarget.scrollTop = drag.startScrollTop - distance;
    }
  };

  const finishCategoryRailDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = categoryRailDragRef.current;
    if (drag.pointerId !== event.pointerId) return;

    const rail = event.currentTarget;
    if (rail.hasPointerCapture(event.pointerId)) {
      rail.releasePointerCapture(event.pointerId);
    }
    rail.classList.remove('is-dragging');
    categoryRailDragRef.current.pointerId = -1;

    if (drag.moved) {
      window.setTimeout(() => {
        suppressCategoryClickRef.current = false;
      }, 0);
    }
  };

  return (
    <section className={`editorial-hero editorial-hero--${heroMode}`}>
      <div className="hero-left-strip"></div>

      <div className="editorial-hero-inner">
        <div className="editorial-cover-zone">
          <article className="catalog-cover">
            <div className="catalog-cover-top">
              <span>{categoryLabel}</span>
              <strong>{displayTitle}</strong>
            </div>
            <div className="catalog-cover-image-wrap">
              <HeroCoverImage src={doc.coverUrl} alt={doc.title} />
            </div>
            <div className="catalog-cover-bottom">
              <strong>{coverMeta}</strong>
              <p>{description}</p>
            </div>
          </article>
        </div>

        <nav
          className="editorial-category-rail"
          aria-label="Categorias destacadas"
          onPointerDown={handleCategoryRailPointerDown}
          onPointerMove={handleCategoryRailPointerMove}
          onPointerUp={finishCategoryRailDrag}
          onPointerCancel={finishCategoryRailDrag}
          onDragStart={(event) => event.preventDefault()}
        >
          {heroCategories.map((category) => {
            const Icon = getCategoryIconComponent(category.icon || 'Tag');
            const iconImage = category.imageUrl;
            return (
              <button
                key={category.id || category.slug}
                className="editorial-category-item"
                onClick={(event) => {
                  if (suppressCategoryClickRef.current) {
                    event.preventDefault();
                    return;
                  }
                  navigate(`/categoria/${category.slug}`);
                }}
                type="button"
              >
                {iconImage ? <img src={iconImage} alt="" /> : <Icon />}
                <span>{category.name}</span>
              </button>
            );
          })}
        </nav>

        <div className="editorial-copy-zone">
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="editorial-title"
            title={displayTitle}
          >
            {titleLines.map((line, index) => (
              index === 0 ? line : <span key={`${line}-${index}`}>{line}</span>
            ))}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="editorial-kicker"
          >
            {categoryLabel}
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="editorial-description"
          >
            {description}
          </motion.p>

          <motion.button
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => navigate(`/viewer/${doc.id}`)}
            onMouseEnter={() => prefetchPdfDocument(doc)}
            onFocus={() => prefetchPdfDocument(doc)}
            onPointerDown={() => prefetchPdfDocument(doc)}
            className="editorial-pdf-button"
          >
            Ver PDF <FileText size={20} />
          </motion.button>
        </div>
      </div>
    </section>
  );
}

