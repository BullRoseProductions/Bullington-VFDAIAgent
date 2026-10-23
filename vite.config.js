import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// One build id per build, shared by the JS bundle (via define -> __BUILD_ID__) and the emitted
// /version.json, so the running app can tell whether it matches the deployed build. On Vercel we
// use the commit SHA (human-verifiable against the deployed commit); locally, a timestamp.
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || String(Date.now());

// The Supabase client is created at module import (src/supabaseClient.js), so a bundle built without these throws
// "supabaseUrl is required" before React renders anything: a black screen with no way out. That is exactly what iOS
// 3.1 build 14 shipped (built in a worktree with no .env; rejected by App Review as "launched to a blank screen").
// Refuse to build instead. loadEnv reads the .env files AND process.env, so Vercel's project vars satisfy it.
const REQUIRED_ENV = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) throw new Error(`[b4c] refusing to build: ${missing.join(", ")} not set (no .env here?) — the bundle would launch to a blank screen.`);
  }
  return {
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
  };
});
