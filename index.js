// Точка входа: собирает config, users, sessions и запускает бота.
const config = require('./config');
const users = require('./users');
const { SessionManager } = require('./session');
const setupBot = require('./bot');

const sessions = new SessionManager(config, users);
const bot = setupBot(config, users, sessions);

// Поднимаем сессии пользователей, которые уже авторизованы
sessions.startAll().catch((e) => console.error('startAll error:', e.message));

// Периодические задачи (автопост и т.п.)
const timer = setInterval(() => {
  try { sessions.tickAll(); } catch (e) { console.error('tickAll error:', e.message); }
}, 30 * 1000);

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

function shutdown(signal) {
  clearInterval(timer);
  try { bot.stop(signal); } catch {}
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
