const { spawnSync } = require('node:child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  ['run', 'build'],
  ['run', 'lint'],
  ['run', 'test:qa'],
];

for (const args of steps) {
  const result = spawnSync(npmCommand, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
