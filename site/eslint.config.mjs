import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".astro/**",
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "dist/**",
    "next-env.d.ts",
  ]),
]);
