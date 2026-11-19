import fs from 'node:fs';

// Read on each request: ownership may change while this local admin is running.
export function localSyncBlockReason(markerPath) {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return '';
    return 'Не удалось прочитать владельца синхронизации. Проверьте migration/sync-owner.json перед локальным запуском.';
  }
  if (marker?.owner === 'nic') {
    return 'Синхронизация передана серверу NIC.RU и выполняется по его расписанию. Локальный запуск отключён, чтобы два процесса не изменяли одни данные одновременно.';
  }
  if (marker?.owner === 'local') return '';
  return 'Неизвестный владелец синхронизации в migration/sync-owner.json. Локальный запуск остановлен до проверки настройки.';
}
