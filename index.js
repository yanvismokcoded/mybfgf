// Точка входа: собирает config, users, sessions и запускает бота.
const config = require('./config');
const users = require('./users');
const { SessionManager } = require('./session');
const setupBot = require('./bot');

const sessions = new SessionManager(config, users);
const bot = setupBot(config, users, sessions);

// Поднимаем сессии пользователей, которые уже авторизованы
sessions.startAll().catch((e) => console.error('startAll error:', e.message));

// Render (Web Service) требует открытый порт — отдаём простой ответ "ok".
// Этот же адрес можно пинговать (например, UptimeRobot), чтобы сервис не засыпал.
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}).listen(PORT, () => console.log(`HTTP на порту ${PORT}`));

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

function shutdown(signal) {
  try { bot.stop(signal); } catch {}
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
