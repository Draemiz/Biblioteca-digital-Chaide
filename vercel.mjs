const backend = process.env.BIBLIOTECA_BACKEND_URL;
if (!backend) throw new Error('Configura BIBLIOTECA_BACKEND_URL en Vercel con la URL HTTPS del servidor persistente. Consulta DEPLOY_VERCEL.md.');
const origin = new URL(backend);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
  throw new Error('BIBLIOTECA_BACKEND_URL debe ser un origen HTTPS sin ruta, credenciales ni parámetros.');
}

export const config = {
  framework: 'vite',
  buildCommand: 'npm run build:vercel',
  outputDirectory: 'dist',
  rewrites: [
    ...['api', 'storage', 'cmaps'].map(prefix => ({ source: `/${prefix}/:path*`, destination: `${origin.origin}/${prefix}/:path*` })),
    { source: '/((?!api/|storage/|cmaps/|assets/).*)', destination: '/index.html' },
  ],
  headers: [{ source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] }],
};
