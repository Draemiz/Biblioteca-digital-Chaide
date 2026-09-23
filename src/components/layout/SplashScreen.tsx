import React from 'react';
import { Loader2 } from 'lucide-react';

export const SplashScreen: React.FC = () => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0B0F19]">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
        <p className="text-white text-lg font-medium animate-pulse">Cargando catálogo...</p>
      </div>
    </div>
  );
};
