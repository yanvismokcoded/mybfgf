const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Личный аккаунт одного пользователя: подключение, вход по коду и 2FA.
// Строка сессии хранится в user.session (users.json).
class Userbot {
  constructor(user, config, users) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.client = null;
    this.phoneCodeHash = null;
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
