const { TopicWatcher } = require('./watcher');
const bigInt = require('big-integer');
const { NewMessage } = require('telegram/events');
const { utils } = require('telegram');

const Userbot = require('./userbot');
const Tapper = require('./tapper');

// Всё, что происходит от имени одного пользователя: его клиент, его каналы,
// его слежка за темами.
class UserSession {
  constructor(user, config, users, bot) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.bot = bot; // telegraf — чтобы писать пользователю в личку

    this.userbot = new Userbot(user, config, users);
    this.tapper = null;
    this.handler = null;
    this.running = false;
    this.dialogsPrimedAt = 0;
    this.titles = new Map();
    this.watcher = new TopicWatcher(this);
  }

  get client() {
    return this.userbot.client;
  }

  requireClient() {
    if (!this.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return this.userbot.client;
  }

  // ---------- запуск / остановка ----------

  async start() {
    if (this.running) return;
    if (!this.user.session) throw new Error('Нет сессии — нужна авторизация /login');

    await this.userbot.connect();
    if (!(await this.userbot.isAuthorized())) {
      throw new Error('Сессия недействительна, нужна повторная авторизация /login');
    }

    this.tapper = new Tapper(this.client, this.user, this.users);
    this.handler = (event) => this.onMessage(event).catch((e) => console.log('handler error', e.message));
    this.client.addEventHandler(this.handler, new NewMessage({}));
    this.running = true;

    await this.primeDialogs();
    console.log(`[user ${this.user.id}] сессия запущена, тем под слежкой: ${this.user.watch.targets.length}`);
  }

  async stop() {
    if (this.handler && this.client) {
      try { this.client.removeEventHandler(this.handler, new NewMessage({})); } catch {}
    }
    this.handler = null;
    this.running = false;
    await this.userbot.disconnect();
  }

  // ---------- уведомления (только в личку владельцу, не в чаты) ----------

  async notify(text) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(this.user.id, text);
    } catch (e) {
      console.log('notify error', e.message);
    }
  }

  async chatTitle(chatId) {
    const key = String(chatId);
    if (this.titles.has(key)) return this.titles.get(key);
    let title = key;
    try {
      const e = await this.client.getEntity(chatId);
      title = e.title || e.username || key;
    } catch {}
    this.titles.set(key, title);
    return title;
  }

  // ---------- вспомогательное ----------

  // gramjs принимает id чата только если он есть в кэше сущностей;
  // кэш наполняется списком диалогов.
  async primeDialogs(force = false) {
    if (!this.client) return;
    if (!force && Date.now() - this.dialogsPrimedAt < 10 * 60 * 1000) return;
    try {
      await this.client.getDialogs({ limit: 500 });
      this.dialogsPrimedAt = Date.now();
    } catch (e) {
      console.log('primeDialogs error', e.errorMessage || e.message);
    }
  }

  // Последние сообщения от служебного аккаунта Telegram (777000) — коды входа.
  async getServiceMessages(limit = 5) {
    const client = this.requireClient();
    await this.primeDialogs();
    try {
      return await client.getMessages('777000', { limit });
    } catch (e) {
      await this.primeDialogs(true);
      return await client.getMessages('777000', { limit });
    }
  }

  // Ссылка/юз/id -> список возможных числовых id чата.
  async resolveChatIds(ref) {
    if (/^-?\d+$/.test(ref)) {
      if (ref.startsWith('-')) return [ref];
      const n = bigInt(ref);
      return [
        bigInt('-1000000000000').subtract(n).toString(), // канал / супергруппа
        bigInt(0).subtract(n).toString() // обычная группа
      ];
    }
    try {
      const entity = await this.client.getEntity(ref);
      return [String(utils.getPeerId(entity))];
    } catch (e) {
      console.log('Не удалось найти чат', ref, e.errorMessage || e.message);
      return null;
    }
  }

  // ---------- входящие сообщения ----------

  async onMessage(event) {
    const msg = event.message;
    if (!msg || msg.out || !this.running) return;

    // Служебные сообщения Telegram (777000): коды входа и оповещения —
    // пересылаем владельцу в личку.
    if (String(msg.chatId) === '777000') {
      const text = msg.text || msg.message || '';
      if (text) await this.notify(`📨 Telegram (777000):\n\n${text}`);
      return;
    }

    await this.watcher.handle(msg, msg.chatId);
  }
}

// --- менеджер сессий: по одной на пользователя ---
class SessionManager {
  constructor(config, users) {
    this.config = config;
    this.users = users;
    this.map = new Map();
    this.bot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  get(userId) {
    const key = String(userId);
    let s = this.map.get(key);
    if (!s) {
      const user = this.users.ensure(key);
      s = new UserSession(user, this.config, this.users, this.bot);
      this.map.set(key, s);
    }
    s.bot = this.bot;
    return s;
  }

  async drop(userId) {
    const key = String(userId);
    const s = this.map.get(key);
    if (s) {
      await s.stop();
      this.map.delete(key);
    }
  }

  // Поднимает сессии всех, кто уже авторизован
  async startAll() {
    for (const user of this.users.all()) {
      if (!user.session) continue;
      try {
        await this.get(user.id).start();
      } catch (e) {
        console.log(`[user ${user.id}] не удалось поднять сессию:`, e.message);
      }
    }
  }
}

module.exports = { UserSession, SessionManager };
