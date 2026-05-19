#!/usr/bin/env node
import { startHttpServer } from './transports/http.js';

startHttpServer().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
