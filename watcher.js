const { Api } = require('telegram');
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

// Слежка за темами: в теме кидают заказ (ссылка на голосование + @юз + ключевое слово),
// следом — опрос "сколько тапнул". Бот тапает, отмечается в опросе и пишет отчёт
// владельцу В ЛИЧКУ. В сам чат с заказами бот ничего не пишет — только голосует в опросе.
class TopicWatcher {
  constructor(session) {
    this.s = session;
    this.pending = []; // [{ link, username, msgId, chatId, topicId, chatTitle, at }]
    this.queue = Promise.resolve(); // тапы идут по одному, чтобы не мешать друг другу
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
    if (!this.matches(msg, chatId)) return false;

    if (msg.media && msg.media.className === 'MessageMediaPoll') {
      return this.onPoll(msg, chatId);
    }

    const text = parser.messageToText(msg);
    if (!/(?:t\.me|telegram\.me)\//i.test(text)) return false;
    if (!this.hasKeyword(text)) return false;

    const parsed = parser.parseVzMessage(text, true) ||
      (() => {
        const link = parser.findAnyPostLink(text);
        return link ? { link, username: null } : null;
      })();
    if (!parsed) return false;

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
    let idx = -1;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.chatId === String(chatId) && p.topicId === topic) { idx = i; break; }
    }
    if (idx === -1) return false; // опрос без заказа перед ним — не трогаем
    const item = this.pending.splice(idx, 1)[0];

    this.queue = this.queue
      .then(() => this.processPoll(msg, chatId, item))
      .catch((e) => console.log('watch error', e.message));
    await this.queue;
    return true;
  }

  async processPoll(msg, chatId, item) {
    const poll = msg.media && msg.media.poll;
    if (!poll || !poll.answers) return;

    if (!item.username) {
      await this.s.notify(
        `⚠️ В заказе не нашёл @юз — тап пропустил, в опросе не отметился.\n` +
        `🔗 Ссылка: ${item.link}\n` +
        `💬 Сообщение: ${await this.messageLink(item.chatId, item.msgId)}`
      );
      return;
    }

    const want = this.cfg.tapCount;

    let already = false;
    try { already = await this.s.tapper.alreadyTapped(item.link); } catch {}

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

    // выбираем вариант ответа в опросе
    let chosen = null;
    if (already) {
      chosen = poll.answers.find((a) => ALREADY_RE.test(answerText(a))) || null;
    } else if (total > 0) {
      const numeric = poll.answers
        .map((a) => ({ a, n: parseInt(answerText(a).replace(/\D/g, ''), 10) }))
        .filter((x) => !Number.isNaN(x.n));
      const exact = numeric.find((x) => x.n === total);
      const notOver = numeric.filter((x) => x.n <= total).sort((x, y) => y.n - x.n)[0];
      const smallest = [...numeric].sort((x, y) => x.n - y.n)[0];
      const pick = exact || notOver || smallest || null;
      chosen = pick ? pick.a : null;
    }

    if (chosen) {
      try {
        await this.s.client.invoke(new Api.messages.SendVote({
          peer: await this.s.client.getInputEntity(chatId),
          msgId: msg.id,
          options: [chosen.option]
        }));
      } catch (e) {
        console.log('vote error', e.errorMessage || e.message);
        chosen = null;
        item.voteError = e.errorMessage || e.message;
      }
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
    else if (item.voteError) lines.push(`⚠️ Не смог проголосовать в опросе: ${item.voteError}`);
    else lines.push('⚠️ Подходящий вариант в опросе не найден — голос не отдан');

    await this.s.notify(lines.join('\n'));
  }
}

module.exports = { TopicWatcher };
