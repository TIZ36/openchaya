/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ELECTRON?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  chateeElectron?: {
    isElectron: boolean;
    platform: string;
  };
}
