// Runs several harder-lab configurations in parallel.
//   node scripts/harder-sweep.mjs '[{"pipMult":1.5},{"knightRate":1}]' [games] [layout] [seats]
import { spawn } from 'node:child_process';
const list = JSON.parse(process.argv[2]);
const rest = process.argv.slice(3);
let next = 0, running = 0;
function go() {
  while (running < 4 && next < list.length) {
    const cfg = JSON.stringify(list[next++]);
    running++;
    const p = spawn(process.execPath, ['scripts/harder-lab.mjs', cfg, ...rest], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.on('close', () => { running--; go(); });
  }
}
go();
