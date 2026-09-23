import React, { useEffect, useMemo, useState } from 'react';
import { Check, Image, Link, Loader2, Smartphone, Upload } from 'lucide-react';
import { PromotionalBannerConfig, useStore } from '../../store/useStore';
import { normalizeDestinationUrl } from '../../lib/linkUtils';

const EMPTY_BANNER: PromotionalBannerConfig = {
  imageUrl: '/anuncio%20web%20(3640x900)-01.png',
  mobileImageUrl: '/anuncio%20web%20(1700x1900).png',
  mobileIsActive: true,
  altText: 'Anuncio promocional Chaide',
  targetUrl: 'https://www.chaide.com/',
  isActive: true,
};

type BannerImageField = 'imageUrl' | 'mobileImageUrl';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

export default function PromotionalBannerManager() {
  const {
    promotionalBanner,
    hasLoadedPromotionalBanner,
    fetchPromotionalBanner,
    updatePromotionalBanner,
    uploadPromotionalBannerImage,
  } = useStore();

  const [form, setForm] = useState<PromotionalBannerConfig>(EMPTY_BANNER);
  const [uploadingField, setUploadingField] = useState<BannerImageField | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    if (!hasLoadedPromotionalBanner) {
      fetchPromotionalBanner();
    }
  }, [fetchPromotionalBanner, hasLoadedPromotionalBanner]);

  useEffect(() => {
    if (promotionalBanner) {
      setForm({
        imageUrl: promotionalBanner.imageUrl || '',
        mobileImageUrl: promotionalBanner.mobileImageUrl || '',
        mobileIsActive: promotionalBanner.mobileIsActive ?? Boolean(promotionalBanner.mobileImageUrl),
        altText: promotionalBanner.altText || EMPTY_BANNER.altText,
        targetUrl: promotionalBanner.targetUrl || '',
        isActive: promotionalBanner.isActive,
        updatedAt: promotionalBanner.updatedAt,
      });
    }
  }, [promotionalBanner]);

  const isUploading = Boolean(uploadingField);

  const canSave = useMemo(() => {
    return !isSaving && !isUploading && Boolean(form.altText.trim());
  }, [form.altText, isSaving, isUploading]);

  const setField = <K extends keyof PromotionalBannerConfig>(
    key: K,
    value: PromotionalBannerConfig[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setStatusMessage('');
  };

  const uploadInto = async (file: File, field: BannerImageField) => {
    setUploadingField(field);
    setStatusMessage('');
    try {
      const url = await uploadPromotionalBannerImage(file);
      setForm((current) => {
        const next = {
          ...current,
          [field]: url,
          isActive: true,
        };

        if (field === 'mobileImageUrl') {
          return {
            ...next,
            mobileIsActive: true,
          };
        }

        if (!current.mobileImageUrl && current.mobileIsActive === undefined) {
          return {
            ...next,
            mobileImageUrl: url,
            mobileIsActive: true,
          };
        }

        return next;
      });
      setStatusMessage(
        field === 'mobileImageUrl'
          ? 'Imagen movil cargada. Guarda los cambios para publicarla en telefonos.'
          : 'Imagen web cargada. Guarda los cambios para publicarla.',
      );
    } catch (error) {
      console.error(error);
      setStatusMessage('No se pudo subir la imagen del banner.');
    } finally {
      setUploadingField(null);
    }
  };

  const handleImageUpload = (field: BannerImageField) => (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void uploadInto(file, field);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;

    setIsSaving(true);
    setStatusMessage('');
    try {
      await updatePromotionalBanner({
        ...form,
        imageUrl: form.imageUrl.trim(),
        mobileImageUrl: form.mobileImageUrl?.trim() || '',
        mobileIsActive: Boolean(form.mobileIsActive),
        altText: form.altText.trim(),
        targetUrl: normalizeDestinationUrl(form.targetUrl),
      });
      setStatusMessage('Banner promocional actualizado.');
    } catch (error) {
      console.error(error);
      setStatusMessage('No se pudo guardar la configuracion del banner.');
    } finally {
      setIsSaving(false);
    }
  };

  const renderUploadButton = (field: BannerImageField, label: string) => {
    const active = uploadingField === field;

    return (
      <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-500">
        {active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {active ? 'Subiendo...' : label}
        <input
          type="file"
          className="hidden"
          accept={IMAGE_ACCEPT}
          onChange={handleImageUpload(field)}
          disabled={isUploading}
        />
      </label>
    );
  };

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-[#111827] text-white">
      <div className="border-b border-white/5 bg-white/[0.02] p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-bold">Banner Promocional</h2>
            <p className="mt-1 text-sm text-gray-500">
              Web/tablet: 3640 x 900 px (~4:1). Movil: 1700 x 1900 px (~9:10).
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {renderUploadButton('imageUrl', 'Subir imagen web')}
            {renderUploadButton('mobileImageUrl', 'Subir imagen movil')}
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">
                Texto alternativo
              </span>
              <input
                type="text"
                value={form.altText}
                onChange={(event) => setField('altText', event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F19] px-4 py-2.5 text-sm text-white transition-colors focus:border-blue-500 focus:outline-none"
                placeholder="Ej: Promocion Catalogo Tecnico 2025"
                required
              />
            </label>

            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
                <Link className="h-3.5 w-3.5" />
                Enlace de destino (opcional)
              </span>
              <input
                type="text"
                value={form.targetUrl || ''}
                onChange={(event) => setField('targetUrl', event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F19] px-4 py-2.5 text-sm text-white transition-colors focus:border-blue-500 focus:outline-none"
                placeholder="https://www.tu-sitio.com"
              />
              <span className="mt-1.5 block text-xs text-gray-500">
                Puedes pegar https://..., www.chaide.com o chaide.com; los dominios externos se abrirán en una pestaña nueva.
                Las rutas internas deben comenzar con /, por ejemplo /viewer/ID.
              </span>
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">
                Imagen web (URL) - 3640 x 900
              </span>
              <input
                type="text"
                value={form.imageUrl}
                onChange={(event) => setField('imageUrl', event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F19] px-4 py-2.5 text-sm text-white transition-colors focus:border-blue-500 focus:outline-none"
                placeholder="/storage/banners/banner.jpg"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
                <Smartphone className="h-3.5 w-3.5" />
                Imagen movil (URL) - 1700 x 1900
              </span>
              <input
                type="text"
                value={form.mobileImageUrl || ''}
                onChange={(event) => setField('mobileImageUrl', event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F19] px-4 py-2.5 text-sm text-white transition-colors focus:border-blue-500 focus:outline-none"
                placeholder="/storage/banners/banner-movil.jpg"
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0B0F19] p-4">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setField('isActive', event.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-white/5"
              />
              <span>
                <span className="block text-sm font-bold text-white">Banner activo</span>
                <span className="block text-xs text-gray-500">
                  Controla web, tablet y movil.
                </span>
              </span>
            </label>

            <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0B0F19] p-4">
              <input
                type="checkbox"
                checked={Boolean(form.mobileIsActive)}
                onChange={(event) => setField('mobileIsActive', event.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-white/5"
              />
              <span>
                <span className="block text-sm font-bold text-white">Banner movil activo</span>
                <span className="block text-xs text-gray-500">
                  Visible solo en telefonos si hay imagen movil.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-3 border-t border-white/5 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-h-5 text-sm text-gray-400">{statusMessage}</p>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Guardar banner
            </button>
          </div>
        </div>

        <aside className="space-y-5 rounded-2xl border border-white/10 bg-[#0B0F19] p-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
              <Image className="h-4 w-4" />
              Vista previa web (4:1)
            </div>
            <div className="aspect-[4/1] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              {form.imageUrl ? (
                <img
                  src={form.imageUrl}
                  alt={form.altText || 'Vista previa del banner web'}
                  className="h-full w-full object-cover object-center"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-gray-500">
                  Sin imagen web
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Smartphone className="h-4 w-4" />
                Vista previa movil (9:10)
              </span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                form.mobileIsActive ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-gray-400'
              }`}>
                {form.mobileIsActive ? 'Activo' : 'Inactivo'}
              </span>
            </div>
            <div className="mx-auto aspect-[9/10] w-40 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              {form.mobileImageUrl ? (
                <img
                  src={form.mobileImageUrl}
                  alt={form.altText || 'Vista previa del banner movil'}
                  className="h-full w-full object-cover object-center"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-2 text-center text-xs text-gray-500">
                  Sin imagen movil
                </div>
              )}
            </div>
          </div>

          <p className="text-xs leading-5 text-gray-500">
            Al guardar, la imagen movil queda almacenada en la misma configuracion del banner. En telefonos
            se usa object-fit: cover y object-position: center para mantener la imagen centrada.
          </p>
        </aside>
      </form>
    </section>
  );
}
