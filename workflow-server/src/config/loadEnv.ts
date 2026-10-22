import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// src/config and build/config are both two levels below workflow-server.
if (process.env.MEETING_NOTE_SKIP_DOTENV !== '1') {
  loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
}
