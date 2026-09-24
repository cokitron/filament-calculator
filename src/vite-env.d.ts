/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the database lives. Set to 'remote' only by the server image's build,
   * so the plain static build (and the Figma Make preview, which has no server)
   * keeps using in-browser OPFS storage. See src/db/client.ts.
   */
  readonly VITE_STORAGE_MODE?: 'local' | 'remote'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
