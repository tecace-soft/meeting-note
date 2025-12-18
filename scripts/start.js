import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = process.env.PORT || '3000';

const serve = spawn('npx', ['serve', 'dist', '-s', '-l', port], {
  stdio: 'inherit',
  shell: true,
  cwd: join(__dirname, '..'),
});

serve.on('error', (error) => {
  console.error('Error starting server:', error);
  process.exit(1);
});

serve.on('exit', (code) => {
  process.exit(code || 0);
});

