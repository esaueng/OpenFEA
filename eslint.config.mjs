import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/fixtures/**",
      "apps/openfea-web/worker/worker-configuration.d.ts"
    ]
  },
  {
    files: [
      "apps/openfea-web/src/**/*.{ts,tsx}",
      "apps/openfea-web/worker/**/*.ts",
      "packages/*/src/**/*.ts",
      "packages/*/tests/**/*.ts",
      "libs/*/src/**/*.ts"
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    // Existing directives name rules this config does not enable (no-console).
    linterOptions: {
      reportUnusedDisableDirectives: "off"
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      eqeqeq: ["error", "always", { null: "ignore" }]
    }
  },
  {
    files: ["apps/openfea-web/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Warn only: the existing findings are mostly effects deliberately keyed
      // to a trigger, and adding deps there would change when they run.
      "react-hooks/exhaustive-deps": "warn",
      // drei's Text (troika) fetches fallback fonts from cdn.jsdelivr.net for
      // any glyph its font lacks; scene labels must stay on-device.
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@react-three/drei",
          importNames: ["Text", "Text3D"],
          message: "Use SceneLabelText (components/SceneLabelText.tsx): it bundles the font and keeps troika off its CDN font resolver."
        }]
      }]
    }
  }
);
