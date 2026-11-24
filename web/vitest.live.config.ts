import { defineConfig } from 'vitest/config';

// `pnpm live`: plays against the deployed contracts with the testnet deployer key from ../contracts/.env.
// `pnpm live:read`: asks the live network what the game and the keeper assume about it; no key, no transaction.
export default defineConfig({ test: { include: ['live/**/*.live.ts'], environment: 'node', testTimeout: 600_000, hookTimeout: 600_000 } });
