// The Studio server's Bun.serve options, which vite.config.ts hands the Bun adapter and the
// Gallery route test builds its server from. They set no idleTimeout on purpose: Bun's 10 s
// default cancels a response whose client stopped reading, which frees its Gallery read permit
// (D5). The owner may still override it with SILUET_SERVER_CONNECTION_IDLE_TIMEOUT.
export const serverEnvPrefix = "SILUET_SERVER_";
export const serverOptions = { hostname: "127.0.0.1" };
