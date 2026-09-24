# Conectar GitHub con Vercel

Repositorio: https://github.com/Draemiz/Biblioteca-digital-Chaide

1. Importa el repositorio en Vercel y selecciona la rama `main`.
2. Usa la raíz del repositorio. La configuración `vercel.mjs` define Vite, `npm run build:vercel` y la salida `dist`.
3. Añade `BIBLIOTECA_BACKEND_URL=https://tu-servidor.example.com` en las variables de Vercel (Production y Preview cuando corresponda). Debe ser el origen HTTPS del servidor, sin rutas ni barra de aplicación.
4. Despliega. Comprueba `/api/health`, el inicio, una categoría, un PDF y `/admin`.
5. Guarda un cambio desde administración y verifica que otra pestaña pública se actualiza.

## Servidor persistente

Vercel sirve la interfaz y reenvía `/api/*`, `/storage/*` y `/cmaps/*` al servidor existente. El servidor debe ejecutar este mismo código con `npm run build` y `npm start`, tener `DATA_DIR` en un disco persistente y `COOKIE_SECURE=true` bajo HTTPS. Los PDFs continúan en Backblaze B2. Los procesos de subida, indexación y los cambios en `db.json` permanecen en ese servidor.

No configures `VITE_STATIC_SITE=true` ni `VITE_FIREBASE_SITE=true` para este despliegue. No publiques las claves ADMIN o B2 como variables `VITE_*`; esas claves van solamente en el servidor, siguiendo `.env.server.example`.

El repositorio contiene una base inicial. Si tu servidor ya tiene datos, conserva y respalda su `DATA_DIR`; no lo reemplaces con la base del repositorio. La migración de categorías se aplica una vez y crea un respaldo local previo.

Los flujos anteriores de Firebase y Docker quedan disponibles por ejecución manual; la publicación en Vercel la gestiona su integración con GitHub.

Referencias: https://vercel.com/docs/project-configuration/vercel-ts y https://vercel.com/docs/routing/rewrites
