import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { npmCommand, runLogged } from '../admin/process.mjs';

test('npm build command runs npm CLI through Node without a .cmd shell', () => {
  const command = npmCommand();
  assert.equal(command[0], process.execPath);
  assert.equal(path.basename(command[1]), 'npm-cli.js');
  assert.deepEqual(command.slice(2), ['run', 'build']);
  assert.match(execFileSync(command[0], [command[1], '--version'], { encoding: 'utf8', windowsHide: true }), /^\d+\.\d+\.\d+/);
});

test('background processes complete once and keep both output streams in a closed log', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-process-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'job.log');
  let calls = 0;
  const result = await new Promise(resolve => runLogged(process.execPath, ['-e', 'process.stdout.write("stdout"); process.stderr.write("stderr");'], {
    cwd: dir, logFile, onFinish: status => { calls++; resolve(status); },
  }));
  assert.equal(result.code, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  const log = await fs.readFile(logFile, 'utf8');
  assert.match(log, /stdout/); assert.match(log, /stderr/);
  assert.equal(calls, 1);
  await fs.rename(logFile, path.join(dir, 'closed.log'));
});

test('spawn error followed by close preserves failure instead of overwriting it', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-process-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const result = await new Promise(resolve => runLogged(path.join(dir, 'missing-command'), [], {
    cwd: dir, logFile: path.join(dir, 'error.log'), onFinish: status => { calls++; resolve(status); },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(result.code, -1); assert.match(result.error, /ENOENT/); assert.equal(calls, 1);
});

test('invalid spawn arguments and log failures are reported without crashing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-process-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const invalid = await new Promise(resolve => runLogged('', [], { cwd: dir, logFile: path.join(dir, 'invalid.log'), onFinish: resolve }));
  assert.equal(invalid.code, -1); assert.ok(invalid.error);
  const logFailure = await new Promise(resolve => runLogged(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], {
    cwd: dir, logFile: path.join(dir, 'missing', 'job.log'), onFinish: resolve,
  }));
  assert.equal(logFailure.code, -1); assert.match(logFailure.error, /ENOENT/);
  await new Promise(resolve => setTimeout(resolve, 30));
});
