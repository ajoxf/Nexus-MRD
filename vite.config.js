import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/*
 * The build stamp.
 *
 * "Is the fix live yet?" cost several rounds of guessing, because nothing on screen said
 * which build the browser was running — a fix could be pushed, built and served, and the
 * only way to tell was to hunt for the behaviour it changed. So the commit is baked in at
 * build time and printed in Settings.
 *
 * Vercel hands the commit to the build as VERCEL_GIT_COMMIT_SHA; there is no .git there to
 * ask. Locally there is no such variable, so git is asked directly. Neither is fatal: an
 * unknown stamp is a stamp that says "unknown", never a build that fails.
 */
const commit = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'unknown'; }
})();

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
