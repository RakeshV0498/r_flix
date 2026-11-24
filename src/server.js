/** Entry point: load config, start monitoring, listen. */
import { loadConfig, ConfigError } from './config.js';
import { createApp } from './app.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const { app, servers, start, stop } = createApp(cfg);
start();

const httpServer = app.listen(cfg.port, () => {
  console.log(`r_flix listening on http://0.0.0.0:${cfg.port}`);
  for (const s of servers) console.log(`  server ${s.index + 1}: ${s.name} (${s.cfg.apiKey ? 'API key' : 'user login'})`); // never log URLs/keys
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
