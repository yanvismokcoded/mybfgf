// Хранилище состояния (config и users), которое должно переживать редеплой.
// Режимы (определяются автоматически):
//   redis — заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN (бесплатный Upstash Redis);
//           данные хранятся там, файлы используются только как копия
//   disk  — задан VOLUME_DIR (путь к подключённому диску Render)
//   temp  — ничего не задано: данные лежат во временной папке и ПРОПАДАЮТ при каждом деплое
const fs = require('fs');
const path = require('path');

const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const hasRemote = !!(REMOTE_URL && REMOTE_TOKEN);

const VOLUME_DIR = process.env.VOLUME_DIR || path.join(__dirname, 'data');
const mode = hasRemote ? 'redis' : (process.env.VOLUME_DIR ? 'disk' : 'temp');
const PREFIX = process.env.STORAGE_PREFIX || 'mybfgf:';
const NAMES = ['config', 'users'];

try { fs.mkdirSync(VOLUME_DIR, { recursive: true }); } catch (e) {
  console.error('Не смог создать папку данных:', e.message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (name) => path.join(VOLUME_DIR, `${name}.json`);

async function redis(cmd) {
  const res = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  let j = {};
  try { j = await res.json(); } catch {}
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j.result;
}

const cache = {};          // name -> JSON-строка, загруженная из redis
const pendingRemote = {};  // name -> JSON-строка, ждущая записи в redis
let flushing = null;

// Загружает данные из redis. Если загрузка не удалась — бросает ошибку:
// лучше не стартовать, чем начать с пустого состояния и затереть сохранённое.
async function init() {
  console.log(`Хранилище: ${mode}${mode === 'temp' ? ' (⚠️ данные пропадут при редеплое!)' : ''}`);
  if (!hasRemote) return;
  for (const name of NAMES) {
    const val = await redis(['GET', PREFIX + name]);
    if (val) {
      cache[name] = val;
    } else if (fs.existsSync(fileOf(name))) {
      // первый запуск с redis: переносим то, что уже лежит в файле
      cache[name] = fs.readFileSync(fileOf(name), 'utf8');
      pendingRemote[name] = cache[name];
    }
  }
  await flush();
}

// Возвращает сохранённый объект или null
function read(name) {
  try {
    if (hasRemote) return cache[name] ? JSON.parse(cache[name]) : null;
    if (fs.existsSync(fileOf(name))) return JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
  } catch (e) {
    console.error(`${name}: сохранённые данные повреждены:`, e.message);
  }
  return null;
}

function kick() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      while (Object.keys(pendingRemote).length) {
        const name = Object.keys(pendingRemote)[0];
        const val = pendingRemote[name];
        delete pendingRemote[name];
        try {
          await redis(['SET', PREFIX + name, val]);
        } catch (e) {
          console.error(`redis: не удалось сохранить ${name}:`, e.message);
          if (!(name in pendingRemote)) pendingRemote[name] = val; // повторим позже
          await sleep(5000);
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

function write(name, obj) {
  const json = JSON.stringify(obj, null, 2);
  try { fs.writeFileSync(fileOf(name), json); } catch (e) {
    if (!hasRemote) console.error(`${name}: не смог записать файл:`, e.message);
  }
  if (hasRemote) {
    cache[name] = json;
    pendingRemote[name] = json;
    kick();
  }
}

// Дожидается записи всего накопленного (вызывается при остановке)
async function flush() {
  while (flushing) await flushing;
  if (Object.keys(pendingRemote).length) await kick();
}

module.exports = { init, read, write, flush, mode, VOLUME_DIR };
