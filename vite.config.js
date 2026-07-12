import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One build id per build, shared by the JS bundle (via define -> __BUILD_ID__) and the emitted
// /version.json, so the running app can tell whether it matches the deployed build. On Vercel we
// use the commit SHA (human-verifiable against the deployed commit); locally, a timestamp.
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || String(Date.now());

export default defineConfig({
  plugins: [
    react(),
    {
      // Emit dist/version.json with the SAME id baked into the bundle. Fetched (no-store) at
      // runtime by the stale-bundle guard in main.jsx to detect a newer deploy.
      name: "emit-version-json",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) + "\n" });
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
