console.clear();

const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const WORK_DIR = __dirname;
const CONFIG_PATH = path.join(WORK_DIR, 'config.json');

let config = loadConfig();

const bot = new Telegraf(config.BOT_TOKEN);
const pendingConfirmations = {}; // для подтверждений /clean

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error('❌ Ошибка загрузки config.json:', e);
    process.exit(1);
  }
}

function isAuthorized(userId) {
  return config.ADMINS.includes(userId);
}

// Middleware проверки авторизации с логами неавторизованных и успешных
async function authMiddleware(ctx, next) {
  if (!ctx.from || !isAuthorized(ctx.from.id)) {
    const user = ctx.from || {};
    console.warn('⚠️ Неавторизованный доступ:');
    console.warn(`  ID: ${user.id}`);
    console.warn(`  Имя: ${user.first_name || '-'}`);
    console.warn(`  Фамилия: ${user.last_name || '-'}`);
    console.warn(`  Ник: ${user.username || '-'}`);
    console.warn('  Объект пользователя:', user);
    await ctx.reply('❌ Вы не авторизованы. Обратитесь к создателю за доступом. @DXIII_tg');
    return;
  }
  console.log(`✅ Авторизованный пользователь: ${ctx.from.username || ctx.from.id}`);
  return next();
}

// /start с логированием попыток и данных
bot.start(async (ctx) => {
  if (!isAuthorized(ctx.from.id)) {
    const user = ctx.from || {};
    console.warn('⚠️ Попытка запуска /start неавторизованным:');
    console.warn(`  ID: ${user.id}`);
    console.warn(`  Имя: ${user.first_name || '-'}`);
    console.warn(`  Фамилия: ${user.last_name || '-'}`);
    console.warn(`  Ник: ${user.username || '-'}`);
    console.warn('  Объект пользователя:', user);
    return ctx.reply('❌ Вы не авторизованы. Обратитесь к создателю за доступом.');
  }
  console.log(`✅ /start от авторизованного пользователя ${ctx.from.username || ctx.from.id}`);
  await ctx.reply(`🤖 Админ-панель управления ассистентом:

/ls — список файлов
/show <файл> — показать файл
/get <файл> <ключ> — получить значение из JSON
/set <файл> <ключ> <значение> — установить значение в JSON
/rm <файл> <ключ> — удалить ключ из JSON
/clean <файл> — очистить файл (требует подтверждения)
/reload — перезагрузить admin.js и index.js
/reboot — перезагрузить Raspberry Pi
`);
});

// Команды с логами и проверкой авторизации
bot.command('ls', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /ls от ${ctx.from.username || ctx.from.id}`);
  try {
    const files = fs.readdirSync(WORK_DIR);
    ctx.reply('📂 Файлы:\n' + files.join('\n'));
  } catch (e) {
    ctx.reply('❌ Ошибка чтения директории.');
    console.error('Ошибка чтения директории:', e);
  }
});

bot.command('show', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /show от ${ctx.from.username || ctx.from.id}`);
  const args = ctx.message.text.split(' ').slice(1);
  const filename = args[0];
  if (!filename) {
    ctx.reply('⚠️ Используй: /show <имя файла>');
    return;
  }
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) {
    ctx.reply(`❌ Файл "${filename}" не найден.`);
    return;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > 4000) {
      ctx.replyWithDocument({ source: filePath });
      return;
    }
    ctx.reply(
      `📄 ${filename}:\n\`\`\`\n${content}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    ctx.reply('❌ Ошибка при чтении файла.');
    console.error('Ошибка при чтении файла:', err);
  }
});

bot.command('get', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /get от ${ctx.from.username || ctx.from.id}`);
  const args = ctx.message.text.split(' ').slice(1);
  const [filename, key] = args;
  if (!filename || !key) {
    ctx.reply('⚠️ Используй: /get <имя файла> <ключ>');
    return;
  }
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) {
    ctx.reply(`❌ Файл "${filename}" не найден.`);
    return;
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!(key in json)) {
      ctx.reply(`❌ Ключ "${key}" не найден.`);
      return;
    }
    ctx.reply(`🔎 ${key} = ${JSON.stringify(json[key])}`);
  } catch (err) {
    ctx.reply('❌ Ошибка при чтении JSON.');
    console.error('Ошибка при чтении JSON:', err);
  }
});

bot.command('set', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /set от ${ctx.from.username || ctx.from.id}`);
  const args = ctx.message.text.split(' ').slice(1);
  const filename = args[0];
  const key = args[1];
  const valueRaw = args.slice(2).join(' ');
  if (!filename || !key || !valueRaw) {
    ctx.reply('⚠️ Используй: /set <имя файла> <ключ> <значение>');
    return;
  }
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) {
    ctx.reply(`❌ Файл "${filename}" не найден.`);
    return;
  }
  try {
    let value = valueRaw;
    try {
      value = JSON.parse(valueRaw);
    } catch { /* оставляем строку */ }
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    json[key] = value;
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
    ctx.reply(`✅ Установлено: ${key} = ${JSON.stringify(value)}`);
  } catch (err) {
    ctx.reply('❌ Ошибка при обновлении JSON.');
    console.error('Ошибка при обновлении JSON:', err);
  }
});

bot.command('rm', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /rm от ${ctx.from.username || ctx.from.id}`);
  const args = ctx.message.text.split(' ').slice(1);
  const [filename, key] = args;
  if (!filename || !key) {
    ctx.reply('⚠️ Используй: /rm <имя файла> <ключ>');
    return;
  }
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) {
    ctx.reply(`❌ Файл "${filename}" не найден.`);
    return;
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!(key in json)) {
      ctx.reply(`❌ Ключ "${key}" не найден.`);
      return;
    }
    delete json[key];
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
    ctx.reply(`🗑 Ключ "${key}" удалён.`);
  } catch (err) {
    ctx.reply('❌ Ошибка при удалении ключа.');
    console.error('Ошибка при удалении ключа:', err);
  }
});

bot.command('clean', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /clean от ${ctx.from.username || ctx.from.id}`);
  const args = ctx.message.text.split(' ').slice(1);
  const filename = args[0];
  if (!filename) {
    ctx.reply('⚠️ Используй: /clean <имя файла>');
    return;
  }
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) {
    ctx.reply(`❌ Файл "${filename}" не найден.`);
    return;
  }
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  pendingConfirmations[ctx.chat.id] = { filename, code };
  ctx.reply(`⚠️ Подтверди очистку файла "${filename}".\nОтправь код: \`${code}\``, { parse_mode: 'Markdown' });
});

bot.command('reload', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /reload от ${ctx.from.username || ctx.from.id}`);
  ctx.reply('♻️ Перезагрузка скриптов admin.js и index.js...');
  exec('sh ./restart_scripts.sh', (error, stdout, stderr) => {
    if (error) {
      ctx.reply(`❌ Ошибка при перезагрузке: ${error.message}`);
      console.error('Ошибка при перезагрузке скриптов:', error);
      return;
    }
    ctx.reply('✅ Скрипты перезагружены.\n' + (stdout || ''));
    console.log('Скрипты успешно перезагружены.');
  });
});

bot.command('reboot', authMiddleware, (ctx) => {
  console.log(`ℹ️ Команда /reboot от ${ctx.from.username || ctx.from.id}`);
  ctx.reply('⚠️ Перезагрузка Raspberry Pi...');
  exec('sudo reboot', (error, stdout, stderr) => {
    if (error) {
      ctx.reply(`❌ Не удалось перезагрузить систему: ${error.message}`);
      console.error('Ошибка перезагрузки Raspberry Pi:', error);
      return;
    }
    // После reboot бот уже не ответит
  });
});

bot.on('text', authMiddleware, (ctx) => {
  const state = pendingConfirmations[ctx.chat.id];
  if (!state) return;

  console.log(`ℹ️ Проверка подтверждения очистки от ${ctx.from.username || ctx.from.id}`);
  if (ctx.message.text.trim() === state.code) {
    const filePath = path.join(WORK_DIR, state.filename);
    try {
      if (path.extname(state.filename) === '.json') {
        fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
      } else {
        fs.writeFileSync(filePath, '');
      }
      ctx.reply(`✅ Файл "${state.filename}" очищен.`);
      console.log(`✅ Файл "${state.filename}" очищен пользователем ${ctx.from.username || ctx.from.id}`);
    } catch (err) {
      ctx.reply('❌ Ошибка при очистке файла.');
      console.error('Ошибка при очистке файла:', err);
    }
  } else {
    ctx.reply('❌ Код не совпадает. Очистка отменена.');
    console.log(`❌ Неверный код подтверждения очистки от ${ctx.from.username || ctx.from.id}`);
  }
  delete pendingConfirmations[ctx.chat.id];
});

bot.launch();
console.log('🤖 Бот запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
