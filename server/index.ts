import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { createApp } from './app';
import { log } from './lib/log';
import { checkSecretsKey } from './lib/secrets';
import { startScheduler } from './services/scheduler';
import { startWebhookDispatcher } from './services/webhooks';
import { startDiscoveryScheduler } from './discovery/service';

async function main() {
  const config = loadConfig();
  const pool = createPool(config);

  if (config.db.migrateOnStart) {
    const applied = await migrate(pool);
    if (applied.length) log.info('db: migrations applied', { applied });
  }

  checkSecretsKey(config);
  const stopScheduler = config.notificationsScheduler ? startScheduler(pool, config) : () => undefined;
  const stopWebhooks = startWebhookDispatcher(pool, config);
  const stopDiscovery = startDiscoveryScheduler(pool, config);

  const app = createApp(pool, config);
  const onListening = () => {
    log.info(`Infrastruktur CMDB listening on ${config.host || '*'}:${config.port}`, { env: config.env, authMode: config.authMode, dbAuth: config.db.auth });
  };
  const server = config.host ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    stopScheduler();
    stopWebhooks();
    stopDiscovery();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal: failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
