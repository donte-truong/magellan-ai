import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Browser tests must not overwrite a running developer server's route artifacts.
  distDir: process.env.MAGELLAN_E2E === "1" ? ".next-e2e" : ".next",
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
