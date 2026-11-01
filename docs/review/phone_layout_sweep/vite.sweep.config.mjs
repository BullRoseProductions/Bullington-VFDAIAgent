import { fileURLToPath } from "url"; import { dirname, join } from "path"; import { readFileSync } from "fs";
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SWEEP_ROOT;
const react = (await import(join(ROOT, "node_modules/@vitejs/plugin-react/dist/index.js"))).default;
export default {
  root: ROOT, configFile: false, logLevel: "warn",
  plugins: [react(), { name: "sweep-page", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url.startsWith("/__sweep")) { res.setHeader("content-type", "text/html"); res.end(readFileSync(join(here, "sweep.html"))); } else next(); }); } }],
  resolve: { alias: [ { find: /^(\.\.?\/)+(src\/)?supabaseClient(\.js)?$/, replacement: join(here, "fakeSupabase.js") }, { find: /^\.\/apiBase(\.js)?$/, replacement: join(here, "fakeApi.js") } ] },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://sweep.invalid"), "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify("sweep") },
  server: { port: 5320, strictPort: true, host: "127.0.0.1", fs: { allow: [ROOT, here, join(ROOT, "..")] } },
};
