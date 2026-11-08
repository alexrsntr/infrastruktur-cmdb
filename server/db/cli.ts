import { loadConfig } from '../config';
import { createPool } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';

const command = process.argv[2];

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    if (command === 'migrate') {
      const applied = await migrate(pool);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    } else if (command === 'seed') {
      await migrate(pool);
      const result = await seed(pool, { force: process.argv.includes('--force') });
      console.log(result);
    } else {
      console.error('Usage: cli.ts migrate | seed [--force]');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
