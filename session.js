const { TopicWatcher } = require('./watcher');
const bigInt = require('big-integer');
const { NewMessage } = require('teleproto/events');
const { utils } = require('teleproto');

const Userbot = require('./userbot');
const Tapper = require('./tapper');

const POLL_EVERY_MS = 6000;

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
    this.seen = []; // последние входящие сообщения (для /debug)
    this.otherChats = new Map(); // id чата → сколько сообщений пришло (для /debug)
    this.processed = new Set(); // "чат:сообщение" — чтобы не обработать одно сообщение дважды
    this.pollTimer = null;
    this.polling = false;
    this.pollState = new Map(); // ключ темы → { chatId, lastId }
    this.pollInfo = { runs: 0, fetched: 0, fed: 0, lastAt: 0, errors: [] };
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
    // Страховка: если Telegram не присылает апдейты из группы, сами забираем новые сообщения
    this.pollTimer = setInterval(() => {
      this.pollTargets().catch((e) => console.log('poll error', e.message));
    }, POLL_EVERY_MS);
    console.log(`[user ${this.user.id}] сессия запущена, тем под слежкой: ${this.user.watch.targets.length}`);
  }

  async stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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

  // ---------- ручной опрос тем (запасной путь) ----------

  async fetchRecent(chatId, topicId) {
    const opts = { limit: 15 };
    if (topicId != null) opts.replyTo = topicId;
    try {
      return await this.client.getMessages(chatId, opts);
    } catch (e) {
      await this.primeDialogs(true); // сущность могла не быть в кэше
      return await this.client.getMessages(chatId, opts);
    }
  }

  async pollTargets() {
    const cfg = this.user.watch;
    if (this.polling || !this.running || !this.client || !cfg || !cfg.enabled) return;
    this.polling = true;
    try {
      for (const t of cfg.targets || []) {
        const key = `${t.chat}|${t.topicId}`;
        const st = this.pollState.get(key) || { chatId: null, lastId: null };
        const candidates = st.chatId ? [st.chatId] : (t.chatIds || []);
        let msgs = null;
        let lastErr = null;
        for (const cid of candidates) {
          try {
            msgs = await this.fetchRecent(cid, t.topicId);
            st.chatId = cid;
            break;
          } catch (e) { lastErr = e; }
        }
        this.pollInfo.runs++;
        this.pollInfo.lastAt = Date.now();
        if (!msgs) {
          const text = `${t.chat}: ${(lastErr && (lastErr.errorMessage || lastErr.message)) || 'нет доступа'}`;
          const errs = this.pollInfo.errors;
          if (!errs.length || errs[errs.length - 1].text !== text) errs.push({ at: Date.now(), text });
          if (errs.length > 5) errs.shift();
          continue;
        }
        const list = [...msgs].filter((m) => m && m.id).sort((a, b) => a.id - b.id);
        if (st.lastId == null) { // первый проход — запоминаем, что уже было, историю не трогаем
          st.lastId = list.length ? list[list.length - 1].id : 0;
          this.pollState.set(key, st);
          continue;
        }
        this.pollState.set(key, st);
        for (const m of list) {
          if (m.id <= st.lastId) continue;
          st.lastId = m.id;
          this.pollInfo.fetched++;
          const before = this.processed.size;
          await this.dispatch(m);
          if (this.processed.size !== before) this.pollInfo.fed++; // это сообщение апдейтами не приходило
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // ---------- входящие сообщения ----------

  async onMessage(event) {
    const msg = event.message;
    if (!msg) return;
    // запоминаем сообщения из отслеживаемых чатов (для /debug), остальные только считаем
    try {
      const cid = String(msg.chatId);
      const watched = ((this.user.watch && this.user.watch.targets) || [])
        .some((t) => Array.isArray(t.chatIds) && t.chatIds.includes(cid));
      if (watched) {
        const rt = msg.replyTo;
        this.seen.push({
          at: Date.now(),
          chatId: cid,
          out: !!msg.out,
          topic: rt && rt.forumTopic ? (rt.replyToTopId || rt.replyToMsgId || null) : null,
          media: msg.media ? msg.media.className : null
        });
        if (this.seen.length > 8) this.seen.shift();
      } else {
        this.otherCount = (this.otherCount || 0) + 1;
        this.otherChats.set(cid, (this.otherChats.get(cid) || 0) + 1);
        if (this.otherChats.size > 15) this.otherChats.delete(this.otherChats.keys().next().value);
      }
    } catch {}
    await this.dispatch(msg);
  }

  // Общая обработка сообщения — и для апдейтов, и для опроса вручную
  async dispatch(msg) {
    if (!this.running) return;
    const key = `${msg.chatId}:${msg.id}`;
    if (this.processed.has(key)) return;
    this.processed.add(key);
    if (this.processed.size > 1000) this.processed.delete(this.processed.values().next().value);
    // свои исходящие сообщения игнорируем; для теста с того же аккаунта: WATCH_OWN=1
    if (msg.out && !process.env.WATCH_OWN) {
      if (process.env.DEBUG_WATCH) console.log(`[watch] пропуск: сообщение отправлено с самого аккаунта бота (чат ${msg.chatId})`);
      return;
    }

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
