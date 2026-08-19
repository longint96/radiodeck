const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_MODE = process.env.SERVICE_MODE || 'systemd';
const LIQUIDSOAP_SERVICE = process.env.LIQUIDSOAP_SERVICE || 'liquidsoap-radio';
const ICECAST_SERVICE = process.env.ICECAST_SERVICE || 'icecast2';

const LIQUIDSOAP_BIN = process.env.LIQUIDSOAP_BIN || '/usr/bin/liquidsoap';
const LIQUIDSOAP_SCRIPT = process.env.LIQUIDSOAP_SCRIPT;
const PID_FILE = path.join(__dirname, '..', '.liquidsoap.pid');

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

async function restartSystemd() {
  // Требует настроенного sudoers NOPASSWD именно для этих двух команд (см. README).
  await execAsync(`sudo systemctl restart ${ICECAST_SERVICE}`);
  await execAsync(`sudo systemctl restart ${LIQUIDSOAP_SERVICE}`);
}

async function statusSystemd() {
  const check = async (svc) => {
    try {
      const out = await execAsync(`systemctl is-active ${svc}`);
      return out === 'active';
    } catch {
      return false;
    }
  };
  return {
    liquidsoap: await check(LIQUIDSOAP_SERVICE),
    icecast: await check(ICECAST_SERVICE),
  };
}

function killPreviousProcess() {
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* процесс уже не существует — не страшно */
      }
    }
    fs.unlinkSync(PID_FILE);
  }
}

async function restartProcess() {
  killPreviousProcess();
  await new Promise((r) => setTimeout(r, 500));

  const child = spawn(LIQUIDSOAP_BIN, [LIQUIDSOAP_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(LIQUIDSOAP_SCRIPT),
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
}

function statusProcess() {
  let running = false;
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0); // просто проверка существования
      running = true;
    } catch {
      running = false;
    }
  }
  return { liquidsoap: running, icecast: null };
}

async function restart() {
  if (SERVICE_MODE === 'systemd') {
    return restartSystemd();
  }
  return restartProcess();
}

async function status() {
  if (SERVICE_MODE === 'systemd') {
    return statusSystemd();
  }
  return statusProcess();
}

module.exports = { restart, status };
