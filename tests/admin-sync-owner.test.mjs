import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localSyncBlockReason } from '../admin/sync-owner.mjs';

test('local sync follows ownership changes and fails closed for unreadable markers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jks-sync-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'sync-owner.json');
  assert.equal(localSyncBlockReason(marker), '');
  fs.writeFileSync(marker, JSON.stringify({ owner: 'nic' }));
  assert.match(localSyncBlockReason(marker), /NIC\.RU/);
  fs.writeFileSync(marker, JSON.stringify({ owner: 'local' }));
  assert.equal(localSyncBlockReason(marker), '');
  fs.writeFileSync(marker, '{invalid');
  assert.match(localSyncBlockReason(marker), /Не удалось прочитать/);
  fs.writeFileSync(marker, JSON.stringify({ owner: 'unknown' }));
  assert.match(localSyncBlockReason(marker), /Неизвестный/);
  fs.unlinkSync(marker);
  assert.equal(localSyncBlockReason(marker), '');
  assert.match(localSyncBlockReason(directory), /Не удалось прочитать/);
});
