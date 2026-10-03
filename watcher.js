const { Api } = require('telegram');
const parser = require('./parser');

// сколько ждём опрос после сообщения со ссылкой, прежде чем считать его протухшим
const PENDING_TTL_MS = 20 * 60 * 1000;
// варианты опроса вида "тзо" / "тапал" / "уже тапал" — значит уже тапали этот пост раньше
const ALREADY_RE = /(?<![а-яa-z])(?:тзо|тапал\S*|тапнул\S*|уже\s*тап\S*)(?![а-яa-z])/i;

function answerText(a) {
  const t = a && a.text;
  if (!t) return '';
  return typeof t === 'string' ? t : (t.text || '');
}

// Тема, где админ регулярно кидает ссылку на тап, а следом — опрос
// ("сколько тапнул?" / "тзо"). Бот тапает, отмечается в опросе и
// присылает отчёт владельцу в личку. Не связано со вз-чатами (user.chats).
class TopicWatcher {
  constructor(session) {
    this.s = session;
    this.pending = []; // [{ link, username, count, msgId, chatId, chatTitle, at }]
  }

  get cfg() {
    return this.s.user.watch;
  }

  // id темы (root-сообщения форума), к которой относится сообщение — или null,
  // если это не форум/не тема.
  getTopicId(msg) {
    const rt = msg.replyTo;
    if (!rt || !rt.forumTopic) return null;
    return rt.replyToTopId || rt.replyToMsgId || null;
  }

  matches(msg, chatId) {
    const cfg = this.cfg;
    if (!cfg || !cfg.enabled) return false;
    if (!cfg.chatIds || !cfg.chatIds.includes(String(chatId))) return false;
    if (cfg.topicId != null && this.getTopicId(msg) !== cfg.topicId) return false;
    return true;
  }

  pruneStale() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
  }

  // Сообщение со ссылкой на тап — запоминаем, ждём опрос следом.
  async onLinkMessage(msg, chatId, parsed) {
    this.pruneStale();
    let chatTitle = String(chatId);
    try { chatTitle = await this.s.chatTitle(chatId); } catch {}
    this.pending.push({
      link: parsed.link,
      username: parsed.username || null,
      count: parsed.count || null,
      msgId: msg.id,
      chatId: String(chatId),
      chatTitle,
      at: Date.now()
    });
  }

  // t.me-ссылка на конкретное сообщение в чате (для отчёта владельцу).
  async messageLink(chatId, msgId) {
    try {
      const entity = await this.s.client.getEntity(chatId);
      if (entity.username) return `https://t.me/${entity.username}/${msgId}`;
    } catch {}
    const idPart = String(chatId).replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${idPart}/${msgId}`;
  }

  // Пришёл опрос: сопоставляем с последней ссылкой в этом же чате, тапаем,
  // голосуем нужным вариантом, шлём отчёт.
  async onPoll(msg, chatId) {
    this.pruneStale();
    const idx = this.pending.map((p) => p.chatId).lastIndexOf(String(chatId));
    if (idx === -1) return; // опрос без парной ссылки перед ним — не трогаем
    const item = this.pending.splice(idx, 1)[0];

    const poll = msg.media && msg.media.poll;
    if (!poll || !poll.answers) return;

    if (!item.username) {
      await this.s.notify(
        `⚠️ В сообщении со ссылкой не нашёл @юз — тап пропустил, в опросе не отметился.\n` +
        `🔗 Ссылка: ${item.link}\n` +
        `💬 Сообщение: ${await this.messageLink(item.chatId, item.msgId)}\n\n` +
        `Если формат сообщений в теме другой — пришлите пример, поправлю разбор.`
      );
      return;
    }

    let already = false;
    try { already = await this.s.tapper.alreadyTapped(item.link); } catch {}

    let total = 0;
    let tapError = null;
    if (!already) {
      try {
        const result = await this.s.tapper.tap(item.link, item.username, item.count || this.s.user.defaultVotes);
        total = result.total;
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
      chosen = (exact || notOver || smallest || null) && (exact || notOver || smallest).a;
    }

    if (chosen) {
      try {
        await this.s.client.invoke(new Api.messages.SendVote({
          peer: await this.s.client.getInputEntity(chatId),
          msgId: msg.id,
          options: [chosen.option]
        }));
      } catch (e) {
        await this.s.log(`❌ Не смог проголосовать в опросе: ${e.errorMessage || e.message}`);
      }
    }

    const cfg = this.cfg;
    cfg.lastAt = Date.now();
    cfg.lastResult = already ? 'тзо' : (tapError ? 'ошибка' : `${total}`);
    this.s.users.save();

    const link = await this.messageLink(item.chatId, item.msgId);
    const lines = [
      already ? '🔁 Этот пост уже тапали раньше — отметился «тзо»'
        : (tapError ? '❌ Ошибка тапа' : '✅ Тапнул'),
      `🔗 Голосование: ${item.link}`,
      `💬 Сообщение в чате: ${link}`
    ];
    if (!already && !tapError) lines.push(`🔢 Тапнуто каналов: ${total}`);
    if (tapError) lines.push(`⚠️ ${tapError}`);
    lines.push(chosen ? `🗳 Отмечено в опросе: ${answerText(chosen)}` : '⚠️ Подходящий вариант в опросе не найден — голос не отдан');

    await this.s.notify(lines.join('\n'));
  }
}

module.exports = { TopicWatcher };
