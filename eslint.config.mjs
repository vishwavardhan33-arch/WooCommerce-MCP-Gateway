// Flat config. Deliberately just the recommended rule sets: no custom rules to explain.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "apps/dashboard/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
