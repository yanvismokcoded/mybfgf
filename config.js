// Общие настройки бота. Секреты берутся из переменных окружения (Render → Environment).
// Изменяемые данные (ownerId, ключи доступа) хранятся в config.json в VOLUME_DIR.
// (чтение/запись идёт через storage.js — Upstash Redis или файл)
const storage = require('./storage');

const VOLUME_DIR = storage.VOLUME_DIR;

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
const saved = storage.read('config');
if (saved && typeof saved === 'object') Object.assign(data, saved);
if (process.env.BOT_TOKEN) data.botToken = process.env.BOT_TOKEN;
if (process.env.API_ID) data.apiId = Number(process.env.API_ID);
if (process.env.API_HASH) data.apiHash = process.env.API_HASH;
if (process.env.OWNER_ID) data.ownerId = Number(process.env.OWNER_ID);
if (!data.pendingKeys || typeof data.pendingKeys !== 'object') data.pendingKeys = {};

function save() {
  // секреты из окружения в хранилище не кладём
  const { botToken, apiHash, ...rest } = data;
  storage.write('config', rest);
}

if (!data.botToken) console.error('⚠️ BOT_TOKEN не задан — бот не сможет запуститься');

module.exports = { data, save, VOLUME_DIR };
