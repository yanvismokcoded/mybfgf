const { Api } = require('teleproto');
const parser = require('./parser');

// сколько ждём опрос после сообщения-заказа, прежде чем считать его протухшим
const PENDING_TTL_MS = 20 * 60 * 1000;
// вариант опроса "тзо" / "тапал" / "уже тапал" — значит этот пост уже тапали раньше
const ALREADY_RE = /(?<![а-яa-z])(?:тзо|тапал\S*|тапнул\S*|уже\s*тап\S*)(?![а-яa-z])/i;

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

function answerText(a) {
  const t = a && a.text;
  if (!t) return '';
  return typeof t === 'string' ? t : (t.text || '');
}

// Достаёт опрос из сообщения (разные версии gramjs кладут его в разные поля)
function getPoll(msg) {
  try {
    const m = msg && msg.media;
    if (m && m.poll && Array.isArray(m.poll.answers)) return m.poll;
    const p = msg && msg.poll;
    if (p && Array.isArray(p.answers)) return p;
    if (p && p.poll && Array.isArray(p.poll.answers)) return p.poll;
  } catch {}
  return null;
}

// Слежка за темами: в теме кидают заказ (ссылка на голосование + @юз + ключевое слово),
// следом — опрос "сколько тапнул". Бот тапает, отмечается в опросе и пишет отчёт
// владельцу В ЛИЧКУ. В сам чат с заказами бот ничего не пишет — только голосует в опросе.
class TopicWatcher {
  constructor(session) {
    this.s = session;
    this.pending = []; // [{ link, username, msgId, chatId, topicId, chatTitle, at }]
    this.queue = Promise.resolve(); // тапы идут по одному, чтобы не мешать друг другу
    this.log = []; // последние события слежки (показывает /debug)
  }

  note(text) {
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 12) this.log.shift();
    if (process.env.DEBUG_WATCH) console.log(`[watch ${this.s.user.id}] ${text}`);
  }

  get cfg() {
    return this.s.user.watch;
  }

  // id темы форума, к которой относится сообщение, или null (нет тем / General)
  getTopicId(msg) {
    const rt = msg.replyTo;
    if (!rt || !rt.forumTopic) return null;
    return rt.replyToTopId || rt.replyToMsgId || null;
  }

  matches(msg, chatId) {
    const cfg = this.cfg;
    if (!cfg || !cfg.enabled) return false;
    const id = String(chatId);
    const topic = this.getTopicId(msg);
    return (cfg.targets || []).some((t) =>
      Array.isArray(t.chatIds) && t.chatIds.includes(id) &&
      (t.topicId == null || t.topicId === topic));
  }

  hasKeyword(text) {
    const words = (this.cfg.keywords || []).map(norm).filter(Boolean);
    if (!words.length) return true;
    const t = norm(text);
    return words.some((w) => t.includes(w));
  }

  pruneStale() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
  }

  // Возвращает true, если сообщение относится к слежке и обработано
  async handle(msg, chatId) {
    const dbg = (m) => this.note(m);
    if (!this.matches(msg, chatId)) {
      const cfg = this.cfg;
      const hit = (cfg.targets || []).some((t) => Array.isArray(t.chatIds) && t.chatIds.includes(String(chatId)));
      if (hit) {
        dbg(cfg.enabled
          ? `сообщение из нужного чата, но тема ${this.getTopicId(msg)} не подходит (ждём ${JSON.stringify((cfg.targets || []).map((t) => t.topicId))})`
          : 'сообщение из нужного чата, но слежка выключена (/watch_on)');
      }
      return false;
    }

    if ((msg.media && msg.media.className === 'MessageMediaPoll') || getPoll(msg)) {
      return this.onPoll(msg, chatId);
    }

    const text = parser.messageToText(msg);
    if (!/(?:t\.me|telegram\.me)\//i.test(text)) {
      const media = msg.media ? msg.media.className : 'нет';
      dbg(`не заказ: нет t.me-ссылки (медиа: ${media}, текст: «${text.slice(0, 40).replace(/\s+/g, ' ')}»)` +
        (media === 'MessageMediaUnsupported' ? ' — вероятно, опрос, который библиотека не понимает (нужен более новый слой Telegram API)' : ''));
      return false;
    }
    if (!this.hasKeyword(text)) { dbg('нет ключевого слова'); return false; }

    const parsed = parser.parseVzMessage(text, true) ||
      (() => {
        const link = parser.findAnyPostLink(text);
        return link ? { link, username: null } : null;
      })();
    if (!parsed) { dbg('не нашёл ссылку на пост'); return false; }
    dbg(`заказ принят: ${parsed.link} @${parsed.username}`);

    await this.onOrderMessage(msg, chatId, parsed);
    return true;
  }

  async onOrderMessage(msg, chatId, parsed) {
    this.pruneStale();
    let chatTitle = String(chatId);
    try { chatTitle = await this.s.chatTitle(chatId); } catch {}
    this.pending.push({
      link: parsed.link,
      username: parsed.username || null,
      msgId: msg.id,
      chatId: String(chatId),
      topicId: this.getTopicId(msg),
      chatTitle,
      at: Date.now()
    });
  }

  // t.me-ссылка на конкретное сообщение в чате (для отчёта владельцу)
  async messageLink(chatId, msgId) {
    try {
      const entity = await this.s.client.getEntity(chatId);
      if (entity.username) return `https://t.me/${entity.username}/${msgId}`;
    } catch {}
    const idPart = String(chatId).replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${idPart}/${msgId}`;
  }

  // Пришёл опрос: берём последний заказ в этой же теме, тапаем, отмечаемся в опросе.
  async onPoll(msg, chatId) {
    this.pruneStale();
    const topic = this.getTopicId(msg);
    this.note(`получен опрос (тема ${topic}), ждущих заказов: ${this.pending.length}`);
    let idx = -1;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.chatId === String(chatId) && p.topicId === topic) { idx = i; break; }
    }
    if (idx === -1) { // опрос без заказа перед ним — не трогаем
      this.note('опрос пропущен: перед ним не было принятого заказа в этой теме');
      return false;
    }
    const item = this.pending.splice(idx, 1)[0];

    this.queue = this.queue
      .then(() => this.processPoll(msg, chatId, item))
      .catch((e) => console.log('watch error', e.message));
    await this.queue;
    return true;
  }

  async processPoll(msg, chatId, item) {
    this.note(`начинаю тап: ${item.link} @${item.username}`);
    try {
      await this._processPoll(msg, chatId, item);
      this.note('тап и ответ в опросе завершены');
    } catch (e) {
      this.note(`ОШИБКА обработки опроса: ${e.errorMessage || e.message}`);
      await this.s.notify(`❌ Ошибка при обработке заказа: ${e.errorMessage || e.message}\n🔗 ${item.link}`);
    }
  }

  // вариант опроса под число n: точное → ближайшее не больше → наименьшее
  pickNumeric(poll, n) {
    const numeric = poll.answers
      .map((a) => ({ a, n: parseInt(answerText(a).replace(/\D/g, ''), 10) }))
      .filter((x) => !Number.isNaN(x.n));
    const exact = numeric.find((x) => x.n === n);
    const notOver = numeric.filter((x) => x.n <= n).sort((x, y) => y.n - x.n)[0];
    const smallest = [...numeric].sort((x, y) => x.n - y.n)[0];
    const pick = exact || notOver || smallest || null;
    return pick ? pick.a : null;
  }

  // option = null — снять голос
  async vote(msg, chatId, option) {
    await this.s.client.invoke(new Api.messages.SendVote({
      peer: await this.s.client.getInputEntity(chatId),
      msgId: msg.id,
      options: option ? [option] : []
    }));
  }

  // Порядок: 1) отмечаемся в опросе, 2) тапаем, 3) если тапнулось иначе, чем планировали — правим голос.
  async _processPoll(msg, chatId, item) {
    const poll = getPoll(msg);
    if (!poll || !poll.answers) {
      this.note('в сообщении не нашёл вариантов опроса');
      return;
    }

    if (!item.username) {
      await this.s.notify(
        `⚠️ В заказе не нашёл @юз — тап пропустил, в опросе не отметился.\n` +
        `🔗 Ссылка: ${item.link}\n` +
        `💬 Сообщение: ${await this.messageLink(item.chatId, item.msgId)}`
      );
      return;
    }

    const want = this.cfg.tapCount;
    const planned = Math.min(want, (this.s.user.channels || []).length);

    let already = false;
    try { already = await this.s.tapper.alreadyTapped(item.link); } catch {}

    // --- 1. сначала голосуем
    let chosen = null;
    let voteError = null;
    if (already) {
      chosen = poll.answers.find((x) => ALREADY_RE.test(answerText(x))) || null;
    } else if (planned > 0) {
      chosen = this.pickNumeric(poll, planned);
    }
    if (chosen) {
      try {
        await this.vote(msg, chatId, chosen.option);
        this.note(`отметился в опросе: «${answerText(chosen)}»`);
      } catch (e) {
        voteError = e.errorMessage || e.message;
        this.note(`не смог проголосовать: ${voteError}`);
        chosen = null;
      }
    } else {
      this.note('подходящий вариант в опросе не найден');
    }

    // --- 2. потом тапаем
    let total = 0;
    let tapError = null;
    let failed = [];
    if (!already) {
      try {
        const result = await this.s.tapper.tap(item.link, item.username, want);
        total = result.total;
        failed = result.failed || [];
      } catch (e) {
        tapError = e.errorMessage || e.message;
      }
    }

    // --- 3. если вышло не то число — правим голос
    let correction = null;
    if (!already && chosen) {
      try {
        if (total === 0) {
          await this.vote(msg, chatId, null);
          correction = 'голос снят, потому что тап не удался';
          chosen = null;
        } else {
          const better = this.pickNumeric(poll, total);
          if (better && !Buffer.from(better.option).equals(Buffer.from(chosen.option))) {
            await this.vote(msg, chatId, better.option);
            correction = `голос исправлен: «${answerText(chosen)}» → «${answerText(better)}»`;
            chosen = better;
          }
        }
      } catch (e) {
        correction = `не смог исправить голос: ${e.errorMessage || e.message}`;
      }
      if (correction) this.note(correction);
    }

    const cfg = this.cfg;
    cfg.lastAt = Date.now();
    cfg.lastResult = already ? 'тзо' : (tapError ? 'ошибка' : `${total}`);
    this.s.users.save();

    const lines = [
      already ? '🔁 Этот пост уже тапали раньше — отметился «тзо»'
        : (tapError ? '❌ Ошибка тапа' : '✅ Тапнул'),
      `💬 Чат: ${item.chatTitle}`,
      `🔗 Голосование: ${item.link}`,
      `👤 Юз: @${item.username}`,
      `📌 Заказ: ${await this.messageLink(item.chatId, item.msgId)}`
    ];
    if (!already && !tapError) {
      lines.push(`🔢 Тапнуто каналов: ${total} из ${want}`);
      if (total < want) lines.push('⚠️ Тапнуто меньше нужного — проверь список каналов (/channels)');
      if (failed.length) lines.push(`Ошибки каналов:\n${failed.slice(0, 5).join('\n')}${failed.length > 5 ? `\n…и ещё ${failed.length - 5}` : ''}`);
    }
    if (tapError) lines.push(`⚠️ ${tapError}`);
    if (chosen) lines.push(`🗳 Отмечено в опросе: ${answerText(chosen)}`);
    else if (voteError) lines.push(`⚠️ Не смог проголосовать в опросе: ${voteError}`);
    else lines.push('⚠️ Голос в опросе не отдан');
    if (correction) lines.push(`ℹ️ ${correction}`);

    await this.s.notify(lines.join('\n'));
  }
}

module.exports = { TopicWatcher };
