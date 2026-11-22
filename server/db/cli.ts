import { loadConfig } from '../config';
import { createPool } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';
import { LocalAccountError, setLocalPassword } from '../auth/localAccounts';

const USAGE = `Usage:
  cli.ts migrate                   apply pending database migrations
  cli.ts seed [--force]            load the demo data (--force wipes the CMDB tables first – never in production)
  cli.ts set-password <e-mail>     set the password of an account (signs it out everywhere)
                                   The password is read from CMDB_NEW_PASSWORD, typed in (hidden) or piped in.`;

const command = process.argv[2];

/**
 * Asks the questions one after the other and reads the answers from the terminal without showing them. The terminal
 * stays in raw mode the whole time – also before the first prompt and between the prompts – so nothing typed or pasted
 * is ever echoed, and answers pasted in one go ("pw⏎pw⏎") are split correctly.
 */
async function promptHidden(questions: string[]): Promise<string[]> {
  const stdin = process.stdin;
  const answers: string[] = [];
  let current = '';
  let lastWasCr = false;
  stdin.setRawMode(true);
  try {
    stdin.setEncoding('utf8');
    process.stderr.write(questions[0]);
    await new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        stdin.removeListener('data', onData);
        stdin.pause();
        if (err) reject(err);
        else resolve();
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          const cr = lastWasCr;
          lastWasCr = ch === '\r';
          if (ch === '\n' && cr) continue; // "\r\n" from a pasted Windows text is one line break
          if (ch === '\u0003') {
            process.stderr.write('\n');
            return finish(new LocalAccountError('Cancelled.'));
          }
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            answers.push(current);
            current = '';
            process.stderr.write('\n');
            if (answers.length === questions.length) return finish();
            process.stderr.write(questions[answers.length]);
          } else if (ch === '\u007f' || ch === '\b') current = current.slice(0, -1);
          else current += ch;
        }
      };
      stdin.on('data', onData);
      stdin.resume();
    });
  } finally {
    stdin.setRawMode(false);
  }
  return answers;
}

/** The new password: CMDB_NEW_PASSWORD, typed in twice (terminal) or the first line of stdin (pipe). Never an argument. */
async function readNewPassword(): Promise<string> {
  const fromEnv = process.env.CMDB_NEW_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    const [first, second] = await promptHidden(['New password: ', 'Repeat the new password: ']);
    if (first !== second) throw new LocalAccountError('The two passwords are not the same.');
    return first;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  if (!piped) throw new LocalAccountError('No password given: set CMDB_NEW_PASSWORD, pipe the password in or run the command in a terminal (docker run -it …).');
  return piped;
}

async function setPassword(email: string | undefined) {
  if (!email || email.startsWith('-')) throw new LocalAccountError(USAGE);
  const password = await readNewPassword();
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const user = await setLocalPassword(pool, email, password);
    console.log(`Password set for ${user.displayName} <${user.email}> (role: ${user.role}). The account was signed out everywhere.`);
    if (!user.active) console.warn('Note: this account is deactivated – it cannot sign in until an administrator activates it again.');
    if (user.role !== 'admin')
      console.warn('Note: this account is not an administrator – while password sign-in is limited to administrators (or LOCAL_LOGIN_EMERGENCY is used), it cannot sign in with a password.');
  } finally {
    await pool.end();
  }
}

async function main() {
  if (command === 'set-password') return setPassword(process.argv[3]);
  if (command !== 'migrate' && command !== 'seed') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const pool = createPool(config);
  try {
    if (command === 'migrate') {
      const applied = await migrate(pool);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    } else {
      await migrate(pool);
      const result = await seed(pool, { force: process.argv.includes('--force') });
      console.log(result);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  if (err instanceof LocalAccountError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
