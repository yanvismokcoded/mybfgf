const { Telegraf } = require('telegraf');
const { Api, utils } = require('telegram');
const crypto = require('crypto');

// Одноразовый ключ вида "A1B2-C3D4"
function generateKey() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function parseArgs(ctx) {
  return ctx.message.text.split(/[\s,;]+/).slice(1).filter(Boolean);
}

// всё, что после команды, одной строкой
function restOf(ctx) {
  return ctx.message.text.replace(/^\/\S+\s*/, '').trim();
}

function fmtMinutes(total) {
  total = Math.max(0, Math.round(total));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  if (m || !parts.length) parts.push(`${m} мин`);
  return parts.join(' ');
}

async function replyLong(ctx, text) {
  const MAX = 4000;
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut <= 0) cut = MAX;
    await ctx.reply(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) await ctx.reply(rest);
}

function helpText(isOwner) {
  return (
    'Бот тапает заказы в темах групп.\n' +
    'Как работает: в теме кидают заказ (ссылка на голосование + @юз + ключевое слово), ' +
    'следом — опрос. Бот тапает твоими каналами, отмечается в опросе ' +
    '(число тапов или «тзо», если пост уже тапали) и присылает отчёт сюда, в личку. ' +
    'В чат с заказами бот ничего не пишет.\n\n' +
    (isOwner ? '👑 Владелец:\n/genkey — выдать ключ регистрации\n/users — список пользователей\n/revoke <id> — удалить пользователя\n/login_code — последние сообщения от Telegram (777000)\n\n' : '') +
    '🔑 Аккаунт:\n' +
    '/login <номер> — вход в свой Telegram (например /login +79990000000)\n' +
    '/code <код> — код из Telegram\n' +
    '/password <пароль> — 2FA\n' +
    '/logout — выйти из аккаунта\n' +
    '/api <apiId> <apiHash> — свои api-ключи (необязательно)\n\n' +
    '📢 Каналы для тапов:\n' +
    '/add_channel <ссылка> [...], /channels, /del_channel <ссылка> [...]\n' +
    '/create_channel <название>\n\n' +
    '👀 Слежка за темами:\n' +
    '/watch — статус и список\n' +
    '/watch_add <ссылка на группу> [id темы | ссылка на сообщение в теме]\n' +
    '/watch_del <номер> — убрать из списка\n' +
    '/watch_words <слово, слово, ...> — ключевые слова заказа (off — любая ссылка с юзом)\n' +
    '/watch_count <число> — сколько каналов тапать (по умолчанию 20)\n' +
    '/watch_on, /watch_off\n' +
    '/del_tap <ссылка|all> — забыть тап по посту, можно тапнуть снова\n\n' +
    '⚙️ /status — статус'
  );
}

function setupBot(config, users, sessions) {
  const bot = new Telegraf(config.data.botToken);
  sessions.setBot(bot);

  // ---------- доступ ----------

  const isOwner = (ctx) => !!config.data.ownerId && String(ctx.from.id) === String(config.data.ownerId);
  const isRegistered = (ctx) => users.has(ctx.from.id);

  const PUBLIC_COMMANDS = ['/start', '/activate', '/help'];

  bot.use((ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== 'private') return; // бот работает только в личке
    if (isRegistered(ctx)) return next();

    const raw = (ctx.message && (ctx.message.text || ctx.message.caption)) || '';
    const cmd = raw.split(/[\s@]/)[0];
    if (PUBLIC_COMMANDS.includes(cmd)) return next();

    return ctx.reply('🔒 Доступ закрыт. Получите ключ у владельца бота и введите:\n/activate <ключ>');
  });

  const U = (ctx) => users.get(ctx.from.id);
  const S = (ctx) => sessions.get(ctx.from.id);

  function clientOf(ctx) {
    const s = S(ctx);
    if (!s.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return s.userbot.client;
  }

  // ---------- регистрация ----------

  bot.start(async (ctx) => {
    if (!config.data.ownerId) {
      config.data.ownerId = ctx.from.id;
      config.save();
      users.ensure(ctx.from.id, { username: ctx.from.username || null, key: 'owner' });
      await ctx.reply('👑 Вы назначены владельцем бота (первый /start). Ключи выдаются командой /genkey.');
    }
    if (!isRegistered(ctx)) {
      return ctx.reply('🔒 Нужна регистрация. Получите ключ у владельца бота и введите:\n/activate <ключ>');
    }
    await replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('help', (ctx) => {
    if (!isRegistered(ctx)) return ctx.reply('🔒 Сначала /activate <ключ>');
    return replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('genkey', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const key = generateKey();
    config.data.pendingKeys[key] = { createdAt: Date.now() };
    config.save();
    ctx.reply(`🔑 Ключ регистрации: \`${key}\`\nОдноразовый. Отправьте новому пользователю.`, { parse_mode: 'Markdown' });
  });

  bot.command('activate', (ctx) => {
    const key = parseArgs(ctx)[0];
    if (!key) return ctx.reply('Формат: /activate <ключ>');
    if (users.has(ctx.from.id)) return ctx.reply('Вы уже зарегистрированы. /start — список команд');

    const normalized = key.toUpperCase();
    if (!config.data.pendingKeys[normalized]) return ctx.reply('❌ Неверный или уже использованный ключ');

    delete config.data.pendingKeys[normalized];
    config.save();

    users.create(ctx.from.id, { username: ctx.from.username || null, key: normalized });

    ctx.reply(
      '✅ Регистрация прошла успешно!\n\n' +
      'Дальше нужно подключить СВОЙ аккаунт Telegram:\n' +
      '1) /login +79990000000\n' +
      '2) /code <код из Telegram>\n' +
      '3) при 2FA — /password <пароль>\n\n' +
      'После этого добавьте каналы для тапов (/add_channel) и темы для слежки (/watch_add).'
    );
  });

  bot.command('users', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const list = users.all();
    if (!list.length) return ctx.reply('Пользователей нет');
    const lines = list.map((u, i) =>
      `${i + 1}. id ${u.id}${u.username ? ' @' + u.username : ''}` +
      ` — вход: ${u.session ? 'да' : 'нет'}, тем: ${u.watch.targets.length}, каналов: ${u.channels.length}`
    );
    replyLong(ctx, `Пользователей: ${list.length}\n` + lines.join('\n'));
  });

  bot.command('revoke', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const id = parseArgs(ctx)[0];
    if (!id) return ctx.reply('Формат: /revoke <id пользователя>');
    if (String(id) === String(config.data.ownerId)) return ctx.reply('Нельзя удалить владельца');
    if (!users.has(id)) return ctx.reply('Такого пользователя нет');
    await sessions.drop(id);
    users.remove(id);
    ctx.reply(`🗑 Пользователь ${id} удалён вместе со своими данными`);
  });

  // ---------- личная авторизация ----------

  bot.command('login', async (ctx) => {
    const u = U(ctx);
    const phone = parseArgs(ctx)[0] || u.phone;
    if (!phone) return ctx.reply('Формат: /login +79990000000');
    if (!/^\+?\d{7,15}$/.test(phone)) return ctx.reply('Похоже, это не номер. Формат: /login +79990000000');

    try {
      const s = S(ctx);
      await s.userbot.connect();
      if (await s.userbot.isAuthorized()) {
        return ctx.reply('Аккаунт уже подключён. Чтобы войти другим — сначала /logout');
      }
      const result = await s.userbot.sendCode(phone.startsWith('+') ? phone : '+' + phone);
      const WHERE = {
        SentCodeTypeApp: 'в другое уже открытое приложение Telegram (телефон/десктоп с этим же аккаунтом) — придёт сообщением от Telegram',
        SentCodeTypeSms: 'по SMS на телефон',
        SentCodeTypeCall: 'голосовым звонком на телефон',
        SentCodeTypeFlashCall: 'звонком-сбросом — код спрятан в номере звонившего',
        SentCodeTypeMissedCall: 'пропущенным звонком — код спрятан в номере звонившего',
        SentCodeTypeEmailCode: 'на привязанную к аккаунту почту'
      };
      const where = WHERE[result?.type?.className] || 'через Telegram';
      ctx.reply(`Код отправлен: ${where}.\nВведите: /code <код>\n(можно с пробелами: /code 1 2 3 4 5)`);
    } catch (e) {
      console.error('login error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('code', async (ctx) => {
    const u = U(ctx);
    const code = ctx.message.text.split(' ').slice(1).join('');
    if (!code) return ctx.reply('Формат: /code 12345');
    try {
      const s = S(ctx);
      const res = await s.userbot.signIn(u.phone, code);
      if (res.twofa) return ctx.reply('Нужен пароль 2FA: /password <пароль>');
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Каналы для тапов: /add_channel, темы для слежки: /watch_add');
    } catch (e) {
      console.error('code error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('password', async (ctx) => {
    const pwd = ctx.message.text.split(' ').slice(1).join(' ');
    if (!pwd) return ctx.reply('Формат: /password пароль');
    try {
      const s = S(ctx);
      await s.userbot.checkPassword(pwd);
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Каналы для тапов: /add_channel, темы для слежки: /watch_add');
    } catch (e) {
      console.error('password error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('logout', async (ctx) => {
    try {
      const s = S(ctx);
      await s.stop();
      await s.userbot.logout();
      await sessions.drop(ctx.from.id);
      ctx.reply('👋 Вышли из аккаунта. Каналы и темы сохранены. Вход снова — /login <номер>');
    } catch (e) {
      ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  // Если у аккаунта уже есть живая сессия, при новом входе Telegram шлёт код
  // сообщением от служебного аккаунта 777000 — эта команда читает его.
  bot.command('login_code', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const s = S(ctx);
    try {
      await s.userbot.connect();
      if (!(await s.userbot.isAuthorized())) {
        return ctx.reply(
          'Текущая сессия недействительна — через бота код так не получить.\n' +
          'Нужно заново авторизоваться: /login <номер>.'
        );
      }
      const messages = await s.getServiceMessages(20);
      const withText = messages.filter((m) => m.message);
      if (!withText.length) return ctx.reply('В служебном чате Telegram (777000) пока пусто.');

      const lines = withText.map((m) => {
        const d = new Date(m.date * 1000);
        const p = (n) => String(n).padStart(2, '0');
        const time = `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
        return `[${time}] ${m.message}`;
      });
      await replyLong(ctx, `📨 Последние сообщения от Telegram:\n\n${lines.join('\n\n')}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('api', (ctx) => {
    const [apiId, apiHash] = parseArgs(ctx);
    const u = U(ctx);
    if (!apiId) {
      return ctx.reply(`Ваши api-ключи: ${u.apiId ? u.apiId + ' (свои)' : (config.data.apiId + ' (общие)')}\nСменить: /api <apiId> <apiHash>`);
    }
    if (!apiHash) return ctx.reply('Формат: /api <apiId> <apiHash>');
    u.apiId = Number(apiId);
    u.apiHash = apiHash;
    users.save();
    ctx.reply('Сохранено. Теперь /logout и заново /login <номер>');
  });

  // ---------- каналы для тапов ----------

  bot.command('add_channel', async (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи одну или несколько ссылок/username каналов');

    const lines = [];
    for (const ref of refs) {
      if (u.channels.includes(ref)) lines.push(`• уже в списке: ${ref}`);
      else {
        u.channels.push(ref);
        lines.push(`✅ ${ref}`);
      }
    }
    users.save();
    await replyLong(ctx, lines.join('\n'));
  });

  bot.command('channels', (ctx) => {
    const u = U(ctx);
    replyLong(ctx, u.channels.length ? `Каналов: ${u.channels.length}\n` + u.channels.join('\n') : 'Список пуст');
  });

  bot.command('del_channel', (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи ссылку/username канала (см. /channels)');
    const before = u.channels.length;
    u.channels = u.channels.filter((c) => !refs.includes(c));
    users.save();
    ctx.reply(`Удалено: ${before - u.channels.length} из ${refs.length}`);
  });

  bot.command('create_channel', async (ctx) => {
    const title = restOf(ctx);
    if (!title) return ctx.reply('Укажи название');
    try {
      const client = clientOf(ctx);
      const result = await client.invoke(new Api.channels.CreateChannel({
        title, about: '', broadcast: true, megagroup: false
      }));
      const channel = result.chats[0];
      const ref = channel.username ? '@' + channel.username : String(utils.getPeerId(channel));
      U(ctx).channels.push(ref);
      users.save();
      ctx.reply(`Канал создан: ${ref}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('del_tap', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const arg = parseArgs(ctx)[0];
    if (!arg) {
      return ctx.reply('Формат: /del_tap <ссылка на пост> — забыть тапы по этому посту, чтобы тапнуть снова\nОчистить всё: /del_tap all');
    }

    if (arg.toLowerCase() === 'all') {
      const count = Object.keys(u.tapped).length;
      u.tapped = {};
      users.save();
      return ctx.reply(`🗑 Забыл про все тапнутые посты (${count})`);
    }

    if (!s.tapper) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
    try {
      const { entity, postId } = await s.tapper.resolveLink(arg);
      if (!postId) return ctx.reply('В ссылке нет номера поста — нужна ссылка вида t.me/chat/123');
      const key = `${entity.id}_${postId}`;
      if (!u.tapped[key]) return ctx.reply('По этой ссылке записанных тапов нет');
      const channelsCount = u.tapped[key].length;
      delete u.tapped[key];
      users.save();
      ctx.reply(`🗑 Забыл тапы по этому посту (было каналов: ${channelsCount}) — можно тапнуть снова`);
    } catch (e) {
      ctx.reply(`❌ ${e.errorMessage || e.message}`);
    }
  });

  // ---------- слежка за темами ----------

  // Приводит ссылку/юз/id группы к виду, который потом можно хранить.
  // Для инвайт-ссылок вступает в группу.
  async function resolveChat(ctx, ref) {
    const client = clientOf(ctx);
    const inviteMatch = ref.match(/(?:t\.me\/\+|t\.me\/joinchat\/)([\w-]+)/);
    if (!inviteMatch) {
      await client.getEntity(ref);
      return ref;
    }
    let chat;
    try {
      const res = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }));
      chat = res.chats && res.chats[0];
    } catch (e) {
      if (e.errorMessage !== 'USER_ALREADY_PARTICIPANT') throw e;
      const info = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteMatch[1] }));
      chat = info.chat;
    }
    if (!chat) throw new Error('Не удалось получить данные чата после вступления');
    return String(utils.getPeerId(chat));
  }

  function parseTopicArg(arg) {
    if (!arg) return null;
    if (/^\d+$/.test(arg)) return parseInt(arg, 10);
    const m = arg.match(/t\.me\/c\/\d+\/(\d+)/) || arg.match(/t\.me\/[a-zA-Z0-9_]+\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function watchStatus(u) {
    const w = u.watch;
    const lines = [
      `👀 Слежка за темами: ${w.enabled ? 'включена' : 'выключена'}`,
      `Тапать каналов: ${w.tapCount} (всего каналов: ${u.channels.length})`,
      `Ключевые слова: ${w.keywords.length ? w.keywords.join(', ') : 'не заданы — любая ссылка с юзом'}`,
      '',
      w.targets.length ? 'Темы:' : 'Темы не заданы — /watch_add <ссылка на группу> [тема]'
    ];
    w.targets.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.chat} — ${t.topicId != null ? 'тема ' + t.topicId : 'любая тема / без тем'}`);
    });
    if (w.lastAt) lines.push('', `Последний разбор: ${fmtMinutes((Date.now() - w.lastAt) / 60000)} назад (${w.lastResult})`);
    return lines.join('\n');
  }

  bot.command('watch', (ctx) => {
    ctx.reply(watchStatus(U(ctx)) + '\n\nКоманды: /watch_add, /watch_del, /watch_words, /watch_count, /watch_on, /watch_off');
  });

  bot.command('watch_add', async (ctx) => {
    const args = parseArgs(ctx);
    if (!args.length) return ctx.reply('Формат: /watch_add <ссылка на группу> [id темы | ссылка на сообщение в теме]');
    const [chatArg, topicArg] = args;

    try {
      const storeRef = await resolveChat(ctx, chatArg);
      const s = S(ctx);
      const chatIds = await s.resolveChatIds(storeRef);
      if (!chatIds) return ctx.reply('❌ Не удалось определить id этого чата');

      let topicId = null;
      if (topicArg) {
        topicId = parseTopicArg(topicArg);
        if (topicId == null) return ctx.reply('Не понял id темы — нужен номер или ссылка вида t.me/c/.../<id>');
      }

      const u = U(ctx);
      // та же группа и та же тема — просто обновляем
      u.watch.targets = u.watch.targets.filter((t) => !(t.chat === storeRef && t.topicId === topicId));
      u.watch.targets.push({ chat: storeRef, chatIds, topicId });
      users.save();
      ctx.reply(
        `✅ Добавлено: ${storeRef}, ${topicId != null ? 'тема ' + topicId : 'любая тема / без тем'}.\n` +
        (topicId == null ? '⚠️ Тема не указана — бот будет реагировать на заказы во ВСЕХ темах этой группы.\n' : '') +
        (u.watch.enabled ? '' : 'Включить слежку: /watch_on')
      );
    } catch (e) {
      ctx.reply(`❌ ${e.errorMessage || e.message}`);
    }
  });

  bot.command('watch_del', (ctx) => {
    const u = U(ctx);
    const n = parseInt(parseArgs(ctx)[0], 10);
    if (!n || n < 1 || n > u.watch.targets.length) return ctx.reply('Формат: /watch_del <номер из /watch>');
    const [removed] = u.watch.targets.splice(n - 1, 1);
    users.save();
    ctx.reply(`🗑 Убрал: ${removed.chat}${removed.topicId != null ? ', тема ' + removed.topicId : ''}`);
  });

  bot.command('watch_words', (ctx) => {
    const u = U(ctx);
    const raw = restOf(ctx);
    if (!raw) {
      return ctx.reply(
        `Ключевые слова: ${u.watch.keywords.length ? u.watch.keywords.join(', ') : 'не заданы'}\n` +
        'Заказ засчитывается, если в сообщении есть любое из них (регистр не важен).\n' +
        'Задать: /watch_words заказ, новый заказ\nОтключить фильтр: /watch_words off'
      );
    }
    if (['off', 'выкл', 'нет', '-'].includes(raw.toLowerCase())) {
      u.watch.keywords = [];
      users.save();
      return ctx.reply('Фильтр выключен: реагирую на любое сообщение со ссылкой и юзом.');
    }
    u.watch.keywords = [...new Set(raw.split(/[,;\n]+/).map((w) => w.trim()).filter(Boolean))];
    users.save();
    ctx.reply(`✅ Ключевые слова: ${u.watch.keywords.join(', ')}`);
  });

  bot.command('watch_count', (ctx) => {
    const u = U(ctx);
    const n = parseInt(parseArgs(ctx)[0], 10);
    if (!n || n < 1 || n > 500) return ctx.reply(`Сейчас: ${u.watch.tapCount}. Формат: /watch_count <число>`);
    u.watch.tapCount = n;
    users.save();
    ctx.reply(`✅ Буду тапать каналов: ${n}`);
  });

  bot.command('watch_on', (ctx) => {
    const u = U(ctx);
    if (!u.watch.targets.length) return ctx.reply('Сначала добавь тему: /watch_add <ссылка на группу> [тема]');
    u.watch.enabled = true;
    users.save();
    ctx.reply('✅ Слежка включена');
  });

  bot.command('watch_off', (ctx) => {
    U(ctx).watch.enabled = false;
    users.save();
    ctx.reply('⏹ Слежка выключена');
  });

  // ---------- статус ----------

  bot.command('status', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    let auth = false;
    try { auth = await s.userbot.isAuthorized(); } catch {}
    ctx.reply(
      `👤 Ваш id: ${u.id}\n` +
      `Аккаунт: ${auth ? 'подключён' + (u.phone ? ' (' + u.phone + ')' : '') : 'не подключён — /login <номер>'}\n` +
      `Сессия: ${s.running ? 'работает' : 'остановлена'}\n\n` +
      watchStatus(u)
    );
  });

  bot.catch((err, ctx) => {
    console.error('bot error:', err);
    try { ctx.reply(`Ошибка: ${err.message}`); } catch {}
  });

  bot.launch();
  return bot;
}

module.exports = setupBot;
