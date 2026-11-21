/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  /** `local` runs the game in the browser, without the contracts. */
  readonly VITE_GAME_MODE?: string;
  /** `off` stops the in-browser gameplay telemetry (see src/play/telemetry.ts). On by default; nothing is sent anywhere. */
  readonly VITE_TELEMETRY?: string;
  /** Fluent Connect app id (app_…) from the Fluent Dashboard. */
  readonly VITE_FLUENT_APP_ID?: string;
  /** Fluent Connect login client (client-…) issued by Fluent. */
  readonly VITE_FLUENT_PRIVY_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
