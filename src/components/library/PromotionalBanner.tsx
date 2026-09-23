import React, { useEffect, useState } from 'react';
import { useStore } from '../../store/useStore';
import { isExternalDestinationUrl, normalizeDestinationUrl } from '../../lib/linkUtils';

interface PromotionalBannerProps {
  className?: string;
}

const MOBILE_QUERY = '(max-width: 767px)';

// Reliable viewport switch: render ONLY the variant for the current device so
// the web (4:1) and mobile (9:10) banners can never appear at the same time,
// independent of any CSS caching/cascade quirks.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler); // older Safari
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, []);

  return isMobile;
}

export default function PromotionalBanner({ className = '' }: PromotionalBannerProps) {
  const banner = useStore((state) => state.promotionalBanner);
  const isMobile = useIsMobile();

  if (!banner?.isActive) return null;

  const webImage = banner.imageUrl?.trim();
  const mobileImage = banner.mobileIsActive !== false ? banner.mobileImageUrl?.trim() : '';

  // Pick the single image for the current device.
  const variant: 'web' | 'mobile' = isMobile ? 'mobile' : 'web';
  const src = isMobile ? mobileImage : webImage;
  if (!src) return null;

  const targetUrl = normalizeDestinationUrl(banner.targetUrl);
  const isExternalTarget = isExternalDestinationUrl(targetUrl);
  const alt = banner.altText || 'Banner promocional';
  const classes = `promotional-banner-frame promotional-banner-frame--${variant}`;
  // This banner is visible immediately below the hero. Eager loading avoids a
  // gray-to-image flash while keeping its aspect-ratio reserved from frame one.
  const img = <img src={src} alt={alt} loading="eager" decoding="async" fetchPriority="high" />;

  return (
    <section className={`promotional-banner-section ${className}`} aria-label={alt}>
      {targetUrl ? (
        <a
          className={classes}
          href={targetUrl}
          target={isExternalTarget ? '_blank' : undefined}
          rel={isExternalTarget ? 'noopener noreferrer' : undefined}
          aria-label={alt}
        >
          {img}
        </a>
      ) : (
        <div className={classes}>{img}</div>
      )}
    </section>
  );
}
