const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

function snapshotCpuTimes() {
  return os.cpus().map((c) => ({
    idle: c.times.idle,
    total: Object.values(c.times).reduce((a, b) => a + b, 0),
  }));
}

/**
 * Загрузка CPU в процентах — по разнице двух снимков времён ядер
 * (os.loadavg() даёт "load average", не проценты, и плохо читается
 * неподготовленным человеком на дашборде).
 */
async function getCpuUsagePercent() {
  const before = snapshotCpuTimes();
  await new Promise((r) => setTimeout(r, 200));
  const after = snapshotCpuTimes();

  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < before.length; i += 1) {
    idleDelta += after[i].idle - before[i].idle;
    totalDelta += after[i].total - before[i].total;
  }
  if (totalDelta <= 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10; // одна десятая процента
}

/**
 * Память через /proc/meminfo (MemAvailable), а не os.freemem() —
 * freemem() на Linux считает файловый кэш "занятым", что вводит в
 * заблуждение (обычно показывает почти всю память "занятой").
 */
function getMemoryInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) * 1024 : null; // kB -> байты
    };
    const totalBytes = get('MemTotal');
    const availableBytes = get('MemAvailable');
    if (totalBytes == null || availableBytes == null) throw new Error('нет нужных полей');

    const usedBytes = totalBytes - availableBytes;
    return {
      totalMb: Math.round(totalBytes / 1024 / 1024),
      usedMb: Math.round(usedBytes / 1024 / 1024),
      percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
    };
  } catch {
    // Фоллбэк на встроенный os-модуль (менее точно, но лучше, чем ничего)
    const totalBytes = os.totalmem();
    const usedBytes = totalBytes - os.freemem();
    return {
      totalMb: Math.round(totalBytes / 1024 / 1024),
      usedMb: Math.round(usedBytes / 1024 / 1024),
      percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
    };
  }
}

/**
 * Место на диске для конкретного пути (обычно — файловая система,
 * на которой лежит медиатека) через df. Работает только на Linux/macOS.
 */
async function getDiskInfo(targetPath) {
  try {
    // -k — в килобайтах, --output гарантирует стабильный порядок колонок
    const out = await execAsync(`df -k --output=size,used,avail,pcent "${targetPath}"`);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const dataLine = lines[lines.length - 1]; // последняя строка — данные, первая — заголовок
    const [sizeKb, usedKb, availKb, pcent] = dataLine.split(/\s+/);

    return {
      totalGb: Math.round((parseInt(sizeKb, 10) / 1024 / 1024) * 10) / 10,
      usedGb: Math.round((parseInt(usedKb, 10) / 1024 / 1024) * 10) / 10,
      availGb: Math.round((parseInt(availKb, 10) / 1024 / 1024) * 10) / 10,
      percent: parseInt(pcent, 10),
      path: targetPath,
    };
  } catch (err) {
    return { error: err.message, path: targetPath };
  }
}

async function getSystemStats(diskPath) {
  const [cpuPercent, disk] = await Promise.all([
    getCpuUsagePercent(),
    getDiskInfo(diskPath),
  ]);
  return {
    cpu: { percent: cpuPercent },
    memory: getMemoryInfo(),
    disk,
    uptimeSeconds: Math.round(os.uptime()),
  };
}

module.exports = { getSystemStats };
