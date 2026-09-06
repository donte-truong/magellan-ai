import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const config: NextConfig = {
  turbopack: { root }, outputFileTracingRoot: root,
  outputFileTracingExcludes: { '/*': ['./runs/**/*', './tests/**/*', './docs/**/*', './.env*'] },
};
export default config;
