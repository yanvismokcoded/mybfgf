const storage = require('./storage');
const config = require('./config');

// Личные данные КАЖДОГО пользователя бота (ключ — telegram id), включая строки сессий.
let data = { users: {} };

const saved = storage.read('users');
if (saved && typeof saved === 'object') data = saved;

if (!data.users || typeof data.users !== 'object') data.users = {};

function save() {
  storage.write('users', data);
}

const DEFAULT_KEYWORDS = ['заказ', 'новый заказ'];

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

    // каналы, от имени которых бот тапает
    channels: [],

    // какие посты уже тапали: "chatId_postId" -> [каналы]
    tapped: {},

    // слежка за темами
    watch: {
      enabled: false,
      targets: [],            // [{ chat, chatIds, topicId }]
      keywords: [...DEFAULT_KEYWORDS], // пусто = реагировать на любую ссылку с юзом
      tapCount: config.data.defaultVotes || 20,
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
  if (!Array.isArray(u.channels)) u.channels = [];
  if (!u.tapped || typeof u.tapped !== 'object') u.tapped = {};

  if (!u.watch || typeof u.watch !== 'object') u.watch = def.watch;
  const w = u.watch;
  if (!Array.isArray(w.targets)) w.targets = [];
  // миграция со старого формата (одна группа)
  if (w.chat && Array.isArray(w.chatIds) && w.chatIds.length && !w.targets.length) {
    w.targets.push({ chat: w.chat, chatIds: w.chatIds, topicId: w.topicId == null ? null : w.topicId });
  }
  delete w.chat; delete w.chatIds; delete w.topicId;
  if (!Array.isArray(w.keywords)) w.keywords = [...DEFAULT_KEYWORDS];
  if (!w.tapCount || w.tapCount < 1) w.tapCount = def.watch.tapCount;
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

module.exports = { data, save, has, get, create, ensure, remove, all };
