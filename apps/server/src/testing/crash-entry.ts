// Test-only server entry (crash-recovery.test.ts): the real composition root, with the claude
// worker replaced by the scripted fake CLI given on the command line. Not used in production and
// not reachable through any environment variable.
import { main } from '../main.js';

const scenario = process.argv[2];
const fakeCli = process.argv[3];
if (!scenario || !fakeCli) {
  process.stderr.write('usage: crash-entry <scenario.json> <fake-cli script>\n');
  process.exit(2);
}
main(process.env, {
  runnerCommands: { claude: [process.execPath, fakeCli, '--fake-scenario', scenario] },
}).catch((err: unknown) => {
  process.stderr.write(`crash-entry: ${(err as Error).message}\n`);
  process.exit(1);
});
