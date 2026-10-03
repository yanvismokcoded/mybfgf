// Общие настройки бота. Секреты берутся из переменных окружения (Render → Environment).
// Изменяемые данные (ownerId, ключи доступа) хранятся в config.json в VOLUME_DIR.
const fs = require('fs');
const path = require('path');

const VOLUME_DIR = process.env.VOLUME_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(VOLUME_DIR, { recursive: true }); } catch (e) {
  console.error('Не смог создать VOLUME_DIR:', e.message);
}

const file = path.join(VOLUME_DIR, 'config.json');

const data = {
  botToken: process.env.BOT_TOKEN || '',
  apiId: Number(process.env.API_ID) || null,
  apiHash: process.env.API_HASH || '',
  ownerId: process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null,

  // сколько каналов тапать по умолчанию (можно поменять в боте: /watch_count)
  defaultVotes: Number(process.env.DEFAULT_VOTES) || 20,

  pendingKeys: {}
};

// Подмешиваем сохранённое состояние; секреты из окружения всегда приоритетнее
try {
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') Object.assign(data, saved);
  }
} catch (e) {
  console.error('config.json битый, использую значения по умолчанию:', e.message);
}
if (process.env.BOT_TOKEN) data.botToken = process.env.BOT_TOKEN;
if (process.env.API_ID) data.apiId = Number(process.env.API_ID);
if (process.env.API_HASH) data.apiHash = process.env.API_HASH;
if (process.env.OWNER_ID) data.ownerId = Number(process.env.OWNER_ID);
if (!data.pendingKeys || typeof data.pendingKeys !== 'object') data.pendingKeys = {};

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('config save error:', e.message);
  }
}

if (!data.botToken) console.error('⚠️ BOT_TOKEN не задан — бот не сможет запуститься');

module.exports = { data, save, VOLUME_DIR };
