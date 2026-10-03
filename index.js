// Точка входа: загружает сохранённое состояние, затем собирает config, users, sessions и запускает бота.
// Предпочитаем IPv4: на Render запросы к api.telegram.org по IPv6 иногда зависают
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const storage = require('./storage');

let bot = null;

async function main() {
  // Сначала подтягиваем данные из хранилища (Upstash Redis), и только потом читаем config/users.
  // Если Redis недоступен — init бросит ошибку, и бот не стартует с пустым состоянием.
  await storage.init();

  const config = require('./config');
  const users = require('./users');
  const { SessionManager } = require('./session');
  const setupBot = require('./bot');

  const sessions = new SessionManager(config, users);
  bot = setupBot(config, users, sessions);

  // Поднимаем сессии пользователей, которые уже авторизованы
  sessions.startAll().catch((e) => console.error('startAll error:', e.message));
}

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

async function shutdown(signal) {
  try { if (bot) bot.stop(signal); } catch {}
  try { await storage.flush(); } catch {}
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('Старт не удался:', e.message);
  process.exit(1);
});
