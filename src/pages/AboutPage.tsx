import React from 'react';
import { ArrowLeft, BookOpen, FileSearch, ShieldCheck, UploadCloud } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const features = [
  {
    title: 'Catálogos centralizados',
    description: 'Organiza PDFs, enlaces y embeds en una biblioteca navegable para el equipo comercial y clientes.',
    icon: BookOpen,
  },
  {
    title: 'Búsqueda por contenido',
    description: 'Indexa documentos PDF para encontrar páginas y términos relevantes dentro de cada catálogo.',
    icon: FileSearch,
  },
  {
    title: 'Gestión administrativa',
    description: 'Permite cargar, reemplazar, editar y categorizar publicaciones desde un panel interno.',
    icon: UploadCloud,
  },
  {
    title: 'Control de publicación',
    description: 'Separa documentos listos, en proceso o con error para evitar mostrar archivos incompletos.',
    icon: ShieldCheck,
  },
];

export default function AboutPage() {
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-[#f5f5f2] pt-24 pb-20 px-4 md:px-8 text-[#111]">
      <div className="max-w-[1100px] mx-auto">
        <button
          className="flex items-center gap-2 text-[#111]/70 hover:text-[#111] transition-colors mb-10 font-medium bg-transparent border-0 cursor-pointer"
          onClick={() => navigate('/')}
        >
          <ArrowLeft className="w-5 h-5" />
          Volver
        </button>

        <header className="mb-12">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#111]/45 mb-4">
            Chaide Biblioteca Digital
          </p>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Biblioteca interna para catálogos y material comercial.
          </h1>
          <p className="text-lg md:text-xl text-[#111]/60 leading-relaxed max-w-3xl">
            Esta app reúne documentos digitales de Chaide en un solo espacio, con visor PDF,
            búsqueda, categorías y herramientas administrativas para mantener el contenido actualizado.
          </p>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <article
                key={feature.title}
                className="bg-white border border-black/5 rounded-2xl p-6 shadow-sm"
              >
                <div className="w-11 h-11 rounded-xl bg-[#111]/5 flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5" />
                </div>
                <h2 className="text-xl font-bold tracking-tight mb-2">{feature.title}</h2>
                <p className="text-sm leading-6 text-[#111]/58">{feature.description}</p>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
