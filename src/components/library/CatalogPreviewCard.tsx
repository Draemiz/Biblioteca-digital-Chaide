import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function CoverImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div
        className="cover-img-placeholder"
        aria-label={alt}
        style={{
          width: '100%',
          height: '100%',
          background: 'linear-gradient(150deg, #1c1c1c 0%, #2e2e2e 60%, #444 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ color: '#666', fontSize: '11px', textAlign: 'center', padding: '8px' }}>
          {alt}
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export type CatalogPreviewCardProps = {
  title: string;
  subtitle?: string;
  coverTitle?: string;
  year?: string;
  image: string;
  brandLabel?: string;
  onClick?: () => void;
  onHover?: () => void;
  href?: string;
  size?: "sm" | "md" | "lg";
  hideInfo?: boolean;
};

const CatalogPreviewCard: React.FC<CatalogPreviewCardProps> = ({
  title,
  subtitle,
  coverTitle,
  year,
  image,
  brandLabel = "CHAIDE BIBLIOTECA DIGITAL",
  onClick,
  onHover,
  href,
  size = "md",
  hideInfo = false,
}) => {
  const navigate = useNavigate();
  const displayYear = year || title.match(/\b20\d{2}\b/)?.[0] || String(new Date().getFullYear());

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.preventDefault();
      onClick();
    } else if (href) {
      e.preventDefault();
      navigate(href);
    }
  };

  const content = (
    <>
      <div className={`catalog-preview-cover catalog-preview-cover--${size}`}>
        <div className="catalog-preview-cover-top">
          <span>{coverTitle || title}</span>
        </div>

        <div className="catalog-preview-cover-image">
          <CoverImage src={image} alt={title} />
        </div>

        <div className="catalog-preview-cover-footer">
          <strong>{displayYear}</strong>
          <small>{brandLabel}</small>
        </div>
      </div>

      {!hideInfo && (
        <div className="catalog-preview-info">
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      )}
    </>
  );

  if (!href && !onClick) {
    return (
      <div className={`catalog-preview-card catalog-preview-card--${size}`}>
        {content}
      </div>
    );
  }

  return (
    <a
      href={href}
      className={`catalog-preview-card catalog-preview-card--${size}`}
      onClick={handleClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      onPointerDown={onHover}
    >
      {content}
    </a>
  );
};

export default CatalogPreviewCard;
