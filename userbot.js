const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// Личный аккаунт одного пользователя: подключение, вход по коду и 2FA.
// Строка сессии хранится в user.session (users.json).
class Userbot {
  constructor(user, config, users) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.client = null;
    this.phoneCodeHash = null;
    this.qr = null; // активная попытка входа по QR
  }

  get apiId() {
    return Number(this.user.apiId || this.config.data.apiId);
  }

  get apiHash() {
    return this.user.apiHash || this.config.data.apiHash;
  }

  saveSession() {
    this.user.session = this.client.session.save();
    this.users.save();
  }

  // Создаёт клиента (если ещё нет) и подключается. Можно вызывать повторно.
  async connect() {
    if (!this.apiId || !this.apiHash) {
      throw new Error('Не заданы API_ID / API_HASH (переменные окружения или /api <apiId> <apiHash>)');
    }
    if (!this.client) {
      this.client = new TelegramClient(
        new StringSession(this.user.session || ''),
        this.apiId,
        this.apiHash,
        { connectionRetries: 5 }
      );
      try { this.client.setLogLevel('error'); } catch {}
    }
    if (!this.client.connected) await this.client.connect();
    return this.client;
  }

  async isAuthorized() {
    if (!this.client) return false;
    try {
      return await this.client.isUserAuthorized();
    } catch (e) {
      console.log(`[user ${this.user.id}] isAuthorized error:`, e.errorMessage || e.message);
      return false;
    }
  }

  // Запрашивает код входа. Возвращает ответ Telegram (в нём type — куда ушёл код).
  async sendCode(phone) {
    await this.connect();
    this.user.phone = phone;
    this.users.save();
    const result = await this.client.invoke(new Api.auth.SendCode({
      phoneNumber: phone,
      apiId: this.apiId,
      apiHash: this.apiHash,
      settings: new Api.CodeSettings({})
    }));
    this.phoneCodeHash = result.phoneCodeHash;
    return result;
  }

  // Вход по коду. Если включена 2FA — возвращает { twofa: true }.
  async signIn(phone, code) {
    await this.connect();
    if (!this.phoneCodeHash) throw new Error('Сначала запросите код: /login <номер>');
    try {
      await this.client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: this.phoneCodeHash,
        phoneCode: String(code).replace(/\s+/g, '')
      }));
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { twofa: true };
      throw e;
    }
    this.phoneCodeHash = null;
    this.saveSession();
    return { twofa: false };
  }

  async checkPassword(password) {
    await this.connect();
    await this.client.signInWithPassword(
      { apiId: this.apiId, apiHash: this.apiHash },
      {
        password: async () => password,
        onError: async (err) => { throw err; }
      }
    );
    this.phoneCodeHash = null;
    this.saveSession();
  }

  // Вход по QR-коду. Пользователь сканирует QR с телефона, где уже открыт этот аккаунт
  // (Настройки → Устройства → Подключить устройство).
  //   onQr(url)            — вызывается при каждом новом QR (токен живёт ~30 с)
  //   askPassword(hint)    — должен вернуть пароль 2FA (если включена)
  //   onWrongPassword()    — пароль не подошёл, сейчас снова вызовется askPassword
  async loginWithQr({ onQr, askPassword, onWrongPassword, timeoutMs = 3 * 60 * 1000 }) {
    await this.cancelQr();
    await this.connect();
    if (typeof this.client.signInUserWithQrCode !== 'function') {
      throw new Error('Эта версия teleproto не поддерживает вход по QR');
    }

    const attempt = { cancelled: false, reason: null };
    this.qr = attempt;
    const timer = setTimeout(() => { this.cancelQr('timeout'); }, timeoutMs);
    const guard = () => { if (attempt.cancelled) throw new Error('QR_CANCELLED'); };

    try {
      await this.client.signInUserWithQrCode(
        { apiId: this.apiId, apiHash: this.apiHash },
        {
          qrCode: async ({ token }) => {
            guard();
            await onQr('tg://login?token=' + Buffer.from(token).toString('base64url'));
          },
          password: async (hint) => {
            guard();
            return askPassword(hint);
          },
          onError: async (err) => {
            if (attempt.cancelled) return true; // остановить
            if (err && err.errorMessage === 'PASSWORD_HASH_INVALID') {
              if (onWrongPassword) await onWrongPassword();
              return false; // спросим пароль ещё раз
            }
            console.log(`[user ${this.user.id}] qr login error:`, (err && (err.errorMessage || err.message)) || err);
            return true;
          }
        }
      );
    } catch (e) {
      if (attempt.cancelled) {
        const err = new Error(attempt.reason === 'timeout' ? 'QR_TIMEOUT' : 'QR_CANCELLED');
        err.qrReason = attempt.reason || 'cancel';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.qr === attempt) this.qr = null;
    }
    this.saveSession();
  }

  // Останавливает текущий вход по QR (если он идёт). Отключаем клиента — так цикл ожидания
  // прерывается сразу, а не через 30 секунд; следующий connect() создаст нового.
  async cancelQr(reason = 'cancel') {
    const a = this.qr;
    if (!a) return false;
    a.cancelled = true;
    a.reason = reason;
    this.qr = null;
    await this.disconnect();
    return true;
  }

  async logout() {
    try {
      if (this.client && this.client.connected) {
        await this.client.invoke(new Api.auth.LogOut());
      }
    } catch (e) {
      console.log(`[user ${this.user.id}] logout error:`, e.errorMessage || e.message);
    }
    this.user.session = '';
    this.users.save();
    await this.disconnect();
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    this.phoneCodeHash = null;
    if (!c) return;
    try { await c.disconnect(); } catch {}
    try { await c.destroy(); } catch {}
  }
}

module.exports = Userbot;
