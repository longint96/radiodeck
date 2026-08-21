const { exec } = require('child_process');
const path = require('path');

// Путь вычисляется относительно __dirname (backend/lib/), а не берётся из
// переменной окружения — так корректно работает при любом INSTALL_DIR,
// без необходимости передавать что-либо через границу sudo (sudo по
// умолчанию сбрасывает большую часть окружения вызывающего процесса).
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'fix-media-permissions.sh');

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve(stdout.trim());
    });
  });
}

/**
 * Восстанавливает владельца (radio:radio) всех файлов текущей медиатеки —
 * нужно, когда файлы попали в папку станции в обход панели (например,
 * через WinSCP/SFTP от другого системного пользователя), из-за чего
 * backend не может прочитать/переписать их ID3/Vorbis-теги.
 * Требует настроенного sudoers NOPASSWD именно для этого скрипта —
 * см. README, раздел про WinSCP/права на файлы.
 */
async function fixMediaPermissions() {
  return execAsync(`sudo ${SCRIPT_PATH}`);
}

module.exports = { fixMediaPermissions };
