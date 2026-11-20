// Preloaded into every Node process of a VibeNode session (NODE_OPTIONS=--require,
// set by engine/runq/__init__.py session_env).
// Acts only for a heavy job: vitest run, jest, playwright test, tsc, vite build,
// webpack. (Go, Cargo and Docker go through the shims folder.) It asks runq for
// admission (blocking until there is room), replays an identical run that just
// passed, or runs with its output captured so identical runs can reuse it.
// Anything else, and any failure here, carries on untouched.
'use strict';

function has(args, ...flags) {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(f + '=')));
}

// A worker count the command sets itself (--flag=N, --flag N, -x N), or 0.
function flagValue(args, long, short) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(long + '=')) return parseInt(a.slice(long.length + 1), 10) || 0;
    if ((a === long || a === short) && i + 1 < args.length) return parseInt(args[i + 1], 10) || 0;
  }
  return 0;
}

// Add --flag=N (half the cores, at most 4) to this process's own arguments,
// which the tool reads after this preload. Returns N.
function capWorkers(args, long) {
  const cores = require('os').cpus().length || 2;
  const n = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  process.argv.push(long + '=' + n);
  return n;
}

(function () {
  try {
    if (process.env.RUNQ_DISABLE === '1' || process.env.RUNQ_LEASE) return;
    const path = require('path');
    const script = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    const args = process.argv.slice(2);
    let kind = null;
    let weight = 0;
    if (/\/vitest\/vitest\.mjs$|\/vitest\/dist\/cli/.test(script)) {
      // Only `vitest run`: watch mode is long-lived and not a batch job.
      if (!args.includes('run') || args.includes('--watch')) return;
      // A worker per core is vitest's default; half the cores, at most 4,
      // keeps one run from taking the whole machine. A set value wins.
      if (!process.env.VITEST_MAX_WORKERS) {
        const cores = require('os').cpus().length || 2;
        process.env.VITEST_MAX_WORKERS = String(Math.max(1, Math.min(4, Math.floor(cores / 2))));
      }
      const w = parseInt(process.env.VITEST_MAX_WORKERS, 10) || 4;
      kind = 'vitest'; weight = 600 + w * 450;
    } else if (/\/typescript\/bin\/tsc$|\/typescript\/lib\/tsc\.js$/.test(script)) {
      if (args.includes('--watch') || args.includes('-w') || args.includes('--version') || args.includes('-v')) return;
      kind = 'tsc'; weight = 2000;
    } else if (/\/vite\/bin\/vite\.js$/.test(script) && args[0] === 'build') {
      kind = 'vite-build'; weight = 3000;
    } else if (/\/jest(-cli)?\/bin\/jest(\.js)?$/.test(script)) {
      if (has(args, '--watch', '--watchAll', '--version', '--help', '--listTests')) return;
      // Jest starts a worker per core less one; half the cores, at most 4,
      // unless the command already says.
      const w = flagValue(args, '--maxWorkers', '-w') || capWorkers(args, '--maxWorkers');
      kind = 'jest'; weight = 600 + w * 450;
    } else if (/\/(@playwright\/test|playwright|playwright-core)\/cli\.js$/.test(script) && args[0] === 'test') {
      if (has(args, '--ui', '--list', '--help')) return;
      // Each worker drives a browser: half the cores, at most 4.
      const w = flagValue(args, '--workers', '-j') || capWorkers(args, '--workers');
      kind = 'playwright'; weight = 800 + w * 700;
    } else if (/\/webpack(-cli)?\/bin\/(webpack|cli)\.js$/.test(script)) {
      if (has(args, '--watch', '-w', 'serve', 'watch', '--version', '--help')) return;
      kind = 'webpack'; weight = 2500;
    } else {
      return;
    }
    const cp = require('child_process');
    const fs = require('fs');
    const py = process.env.RUNQ_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const cli = path.join(__dirname, 'runq.py');
    const label = kind + ' ' + args.join(' ').slice(0, 200);
    const r = cp.spawnSync(py, ['-I', cli, 'admit', kind, String(weight), String(process.pid),
      process.cwd(), JSON.stringify(args), label],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONPATH: __dirname }) });
    if (r.status !== 0 || !r.stdout) return;
    const [action, a, b] = JSON.parse(r.stdout.trim().split('\n').pop());
    if (action === 'replay') {
      process.stderr.write('[runq] identical run on the same code just passed: replaying its result\n');
      fs.writeSync(1, fs.readFileSync(a));
      process.exit(b);
    }
    if (action !== 'run') return;
    const lease = a;
    process.env.RUNQ_LEASE = lease;
    const fd = fs.openSync(b, 'w');
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      stream.write = function (chunk, enc, cb) {
        try { fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch (e) {}
        return orig(chunk, enc, cb);
      };
    }
    // What this run really uses, every few seconds, so the next run of this
    // tool here is budgeted from fact. A final sample runs just before finish.
    const sampleNow = (sync) => {
      const argv = ['-I', cli, 'sample', lease, String(process.pid)];
      const opts = { stdio: 'ignore', windowsHide: true };
      try { sync ? cp.spawnSync(py, argv, opts) : cp.spawn(py, argv, opts).unref(); } catch (e) {}
    };
    const timer = setInterval(() => sampleNow(false), 4000);
    timer.unref();
    process.on('exit', (code) => {
      clearInterval(timer);
      try { fs.closeSync(fd); } catch (e) {}
      try {
        cp.spawnSync(py, ['-I', cli, 'finish', lease, String(code)],
          { stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { PYTHONPATH: __dirname }) });
      } catch (e) {}
    });
  } catch (e) { /* fail open */ }
})();
