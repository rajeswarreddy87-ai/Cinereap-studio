// Self-contained ESLint flat config (no external deps) for the render server.
// Purpose: catch the ReferenceError bug class that `node --check` cannot see and
// that repeatedly collapsed renders (isProtectedBeatForVisual, _dedupeCandidates,
// sourceTranscriptSegments, _preTrimBeats, srcDurClip, fileId, ...).
const nodeGlobals = {
  process: "readonly", Buffer: "readonly", console: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
  clearInterval: "readonly", setImmediate: "readonly", queueMicrotask: "readonly",
  global: "readonly", globalThis: "readonly", __dirname: "readonly",
  __filename: "readonly", module: "readonly", require: "readonly", exports: "writable",
  URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly",
  TextDecoder: "readonly", fetch: "readonly", FormData: "readonly", Blob: "readonly",
  structuredClone: "readonly", AbortController: "readonly", AbortSignal: "readonly",
  Response: "readonly", Request: "readonly", Headers: "readonly",
};

export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      // The gate: undefined references become deploy-blocking errors.
      "no-undef": "error",
      "no-unused-vars": "off",
    },
  },
];
