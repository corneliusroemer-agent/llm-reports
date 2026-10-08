/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated CORS proxy templates tried before the defaults, e.g. https://x.workers.dev/?url={url} */
  readonly VITE_CORS_PROXY?: string;
}
