const fs = require('fs');
const path = require('path');
const config = require('./config');

// Личные данные КАЖДОГО пользователя бота.
// Ключ — telegram id пользователя. Никаких общих чатов/каналов/сессий:
// новый пользователь получает пустую карточку и логинится своим аккаунтом.

const file = path.join(config.VOLUME_DIR, 'users.json');

let data = { users: {} };

try {
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  }
} catch (e) {
  console.error('users.json битый, начинаю с пустого:', e.message);
  data = { users: {} };
}

if (!data.users || typeof data.users !== 'object') data.users = {};

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('users save error:', e.message);
  }
}

function blank(id) {
  return {
    id: String(id),
    username: null,
    registeredAt: Date.now(),
    key: null,

    // личная авторизация в Telegram
    phone: null,
    session: '',
    apiId: null, // если null — берётся общий из config
    apiHash: null,

    // личные списки
    chats: [],
    channels: [],
    folders: [],

    // личные каналы для служебных сообщений
    dealsChannel: '', // канал с договорами о вз
    logsChannel: '', // технический лог

    // личные настройки
    defaultVotes: config.data.defaultVotes,
    confirmKeyword: config.data.confirmKeyword,
    doneKeyword: config.data.doneKeyword,
    afterYouReply: config.data.afterYouReply,
    answerGeneralOffers: config.data.answerGeneralOffers,

    autopost: { enabled: false, text: '', entities: [], intervalMin: null, lastAt: null, nextAt: null, lastResult: null },

    ownPosts: {}, // "chatId_msgId" сообщений, которые отправил ВЗ-модуль бота (автопост, предложения, наше "вз") -> timestamp

    // какие каналы уже тапали какой пост (чтобы не дублировать)
    tapped: {},

    // наблюдение за темой: ссылка на тап + опрос -> тапнуть, отметиться в опросе, отчитаться (см. watcher.js)
    watch: {
      enabled: false,
      chat: '',      // ссылка/юз/id группы, как ввёл пользователь
      chatIds: [],   // резолвнутые числовые id этой группы (супергруппа/обычная)
      topicId: null, // id темы форума; null — любая тема / чат без тем
      lastAt: null,
      lastResult: null
    }
  };
}

// дописывает поля, появившиеся в новых версиях
function normalize(u) {
  const def = blank(u.id);
  for (const [k, v] of Object.entries(def)) {
    if (u[k] === undefined) u[k] = v;
  }
  for (const k of ['chats', 'channels', 'folders']) {
    if (!Array.isArray(u[k])) u[k] = [];
  }
  if (!u.autopost || typeof u.autopost !== 'object') u.autopost = def.autopost;
  if (!u.tapped || typeof u.tapped !== 'object') u.tapped = {};

  if (!u.ownPosts || typeof u.ownPosts !== 'object' || Array.isArray(u.ownPosts)) u.ownPosts = {};

  if (!u.watch || typeof u.watch !== 'object') u.watch = def.watch;
  if (!Array.isArray(u.watch.chatIds)) u.watch.chatIds = [];

  return u;
}

function has(id) {
  return !!data.users[String(id)];
}

function get(id) {
  const u = data.users[String(id)];
  return u ? normalize(u) : null;
}

function create(id, extra = {}) {
  const u = Object.assign(blank(id), extra);
  data.users[String(id)] = u;
  save();
  return u;
}

function ensure(id, extra = {}) {
  return get(id) || create(id, extra);
}

function remove(id) {
  delete data.users[String(id)];
  save();
}

function all() {
  return Object.values(data.users).map(normalize);
}

module.exports = { data, save, has, get, create, ensure, remove, all, file };
