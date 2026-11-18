import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(file => file && path.isAbsolute(file) && path.basename(file) === 'npm-cli.js' && fs.existsSync(file));
  if (!cli) throw new Error('Не найден npm-cli.js. Запустите админку через npm start или установите npm рядом с Node.js.');
  return [process.execPath, cli, 'run', 'build'];
}

// One completion callback, even when spawn emits error followed by close.
export function runLogged(command, args, { cwd, logFile, onFinish }) {
  let child;
  let finished = false;
  const log = fs.createWriteStream(logFile);
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    if (!log.destroyed) log.end(error ? `\n${error.message}\n` : undefined);
    onFinish({ code: error ? -1 : code, error: error?.message || null });
  };
  log.on('error', error => { child?.kill(); finish(-1, error); });
  try {
    child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', error => finish(-1, error));
    child.once('close', code => finish(code, null));
  } catch (error) { finish(-1, error); }
  return child;
}
