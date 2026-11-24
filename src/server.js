/** Entry point: open the database, start monitoring, listen. */
import { loadBootstrap, readLegacy, ConfigError } from './config.js';
import { createApp } from './app.js';

let boot, legacy;
try {
  boot = loadBootstrap();
  legacy = readLegacy(); // only used to seed an empty database (see config.js)
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const ctx = createApp({ dataDir: boot.dataDir, trustProxy: boot.trustProxy, legacy });
ctx.start();

const httpServer = ctx.app.listen(boot.port, () => {
  console.log(`r_flix listening on http://0.0.0.0:${boot.port}  (data: ${boot.dataDir})`);
  const code = ctx.getSetupCode();
  if (code) {
    console.log('');
    console.log('  ┌───────────────────────────────────────────────────────────────┐');
    console.log('  │  First run: open r_flix in your browser to create the admin    │');
    console.log(`  │  account.   Setup code:  ${code.padEnd(37)}│`);
    console.log('  └───────────────────────────────────────────────────────────────┘');
    console.log('');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    ctx.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
