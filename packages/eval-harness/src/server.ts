import Fastify from "fastify";
import path from "node:path";
import { Store } from "./db/store.js";
import { registerRoutes } from "./routes/api.js";

export interface BuildOptions {
  dbPath?: string;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}) {
  const dbPath = opts.dbPath ?? path.resolve(process.cwd(), "data", "eval.db");
  const store = new Store(dbPath);
  const app = Fastify({ logger: opts.logger ?? false });
  registerRoutes(app, { store });
  // Expose store for tests / shutdown hooks.
  (app as unknown as { store: Store }).store = store;
  app.addHook("onClose", async () => {
    store.close();
  });
  return app;
}

async function main() {
  const app = await buildApp({ logger: true });
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = (() => {
  try {
    if (typeof process === "undefined") return false;
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}