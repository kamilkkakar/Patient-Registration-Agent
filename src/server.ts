// Process entry point: read env, build the app, listen, shut down cleanly.
//
// `dotenv/config` must be the first import — ES module bodies evaluate in import
// order, so this populates process.env before `./app` (and, transitively, the
// Prisma client) reads DATABASE_URL.

import 'dotenv/config';
import { buildApp } from './app.js';
import { logger } from './lib/logger.js';

const PORT = Number(process.env.PORT ?? 3000);
// 0.0.0.0 rather than localhost: Railway and Docker route to the container's
// external interface, and binding loopback there yields a silent health-check
// failure.
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: PORT, host: HOST });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
