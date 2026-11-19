import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const php = process.env.PHP_BIN || 'php';
const available = spawnSync(php, ['-v'], { windowsHide: true }).status === 0;
test('VK public widget collector preserves data on incomplete/auth/future responses', { skip: !available && 'Set PHP_BIN' }, () => {
  const result = spawnSync(php, ['tests/vk-sync-php.php'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.passed >= 45);
  assert.equal(report.network_used, false);
});
