console.clear();

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const WORK_DIR = __dirname;
const CONFIG_PATH = path.join(WORK_DIR, 'config.json');
const LOGS_DIR = path.join(WORK_DIR, 'logs');

// Белый список файлов, которые можно просматривать/редактировать через бота
const ALLOWED_FILES = new Set([
  'config.json',
  'data.json',
  'settings.json',
  'users.json'
]);

let config = loadConfig();
const bot = new Telegraf(config.BOT_TOKEN);
const pendingConfirmations = {}; // для подтверждений /clean
const resmonIntervals = {}; // для хранения интервалов мониторинга
const resmonState = {}; // хранит lastText и messageId для каждого чата

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('❌ Ошибка загрузки config.json:', e);
    process.exit(1);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  config = loadConfig();
}

function isAuthorized(userId) {
  if (!config || !Array.isArray(config.ADMINS)) return false;
  return config.ADMINS.includes(userId);
}

async function notifyAdmins(message, extra = {}) {
  for (const adminId of config.ADMINS) {
    try {
      await bot.telegram.sendMessage(adminId, message, extra);
    } catch (err) {
      console.error(`❌ Ошибка отправки админу ${adminId}:`, err?.message || err);
    }
  }
}

// Централизованная проверка авторизации для ВСЕХ апдейтов
async function checkAuth(ctx) {
  if (!ctx.from) return true;
  if (isAuthorized(ctx.from.id)) return true;

  const user = ctx.from || {};
  const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '-';

  try {
    await ctx.reply('❌ Вы не авторизованы. Обратитесь к создателю за доступом. @DXIII_tg');
  } catch (e) {
    // игнорируем ошибки
  }

  try {
    await notifyAdmins(
      `🚨 Попытка авторизации:\nПользователь: ${fullName} (${user.id})\nНик: @${user.username || '-'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Разрешить доступ', `allow_${user.id}`)],
        [Markup.button.callback('🚫 Отказать в доступе', `deny_${user.id}`)]
      ])
    );
  } catch (e) {
    console.error('Ошибка уведомления админов:', e);
  }

  return false;
}

bot.use(async (ctx, next) => {
  try {
    const ok = await checkAuth(ctx);
    if (!ok) return;
  } catch (e) {
    console.error('Ошибка в checkAuth:', e);
    return;
  }
  return next();
});

bot.action(/allow_(\d+)/, async (ctx) => {
  const newUserId = Number(ctx.match[1]);
  if (!isAuthorized(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Нет прав', { show_alert: true }).catch(() => {});
    return;
  }

  if (!config.ADMINS.includes(newUserId)) {
    config.ADMINS.push(newUserId);
    saveConfig();
    try {
      await ctx.reply(`✅ Пользователь ${newUserId} добавлен в список админов.`);
      await bot.telegram.sendMessage(newUserId, '✅ Вам предоставлен доступ к боту.');
    } catch {}
  } else {
    await ctx.reply('ℹ️ Этот пользователь уже имеет доступ.');
  }
  await ctx.answerCbQuery().catch(() => {});
});

bot.action(/deny_(\d+)/, async (ctx) => {
  const denyUserId = Number(ctx.match[1]);
  if (!isAuthorized(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Нет прав', { show_alert: true }).catch(() => {});
    return;
  }
  try {
    await ctx.reply(`🚫 Пользователю ${denyUserId} отказано в доступе.`);
    await bot.telegram.sendMessage(denyUserId, '🚫 Вам отказано в доступе к боту.');
  } catch {}
  await ctx.answerCbQuery().catch(() => {});
});

function allowedFile(filename) {
  if (!filename) return false;
  // Запрет на обход с помощью ../
  if (filename.includes('..')) return false;
  const base = path.basename(filename);
  return ALLOWED_FILES.has(base);
}

function getDiskUsage(callback) {
  exec('df -k /', (err, stdout) => {
    if (err) return callback(err);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return callback(new Error('Unexpected df output'));
    const parts = lines[1].split(/\s+/);
    const totalKB = Number(parts[1]);
    const usedKB = Number(parts[2]);
    const availKB = Number(parts[3]);
    const usePercent = parts[4];
    callback(null, { totalKB, usedKB, availKB, usePercent });
  });
}

// /start
bot.start(async (ctx) => {
  try {
    await ctx.reply(`🤖 Админ-панель управления ассистентом:

/ls — список файлов
/show <файл> — показать файл
/get <файл> <ключ> — получить значение из JSON
/set <файл> <ключ> <значение> — установить значение в JSON
/rm <файл> <ключ> — удалить ключ из JSON
/clean <файл> — очистить файл (требует подтверждения)
/reboot — перезагрузить Raspberry Pi
/log — показать последний лог
/resmon — мониторинг ресурсов
`);
  } catch (e) {
    console.error('/start reply error:', e);
  }
});

// /ls
bot.command('ls', async (ctx) => {
  try {
    const files = fs.readdirSync(WORK_DIR);
    await ctx.reply('📂 Файлы:\n' + files.join('\n'));
  } catch (e) {
    console.error('ls error:', e);
    try { await ctx.reply('❌ Ошибка чтения директории.'); } catch {}
  }
});

// /show
bot.command('show', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const filename = args[0];
  if (!filename) return ctx.reply('⚠️ Используй: /show <имя файла>');
  if (!allowedFile(filename)) return ctx.reply('❌ Доступ к этому файлу запрещён.');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return ctx.reply(`❌ Файл "${filename}" не найден.`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > 4000) {
      await ctx.replyWithDocument({ source: filePath });
    } else {
      await ctx.reply(`📄 ${filename}:\n\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('/show error:', err);
    try { await ctx.reply('❌ Ошибка при чтении файла.'); } catch {}
  }
});

// /get
bot.command('get', async (ctx) => {
  const [filename, key] = ctx.message.text.split(' ').slice(1);
  if (!filename || !key) return ctx.reply('⚠️ Используй: /get <имя файла> <ключ>');
  if (!allowedFile(filename)) return ctx.reply('❌ Доступ к этому файлу запрещён.');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return ctx.reply(`❌ Файл "${filename}" не найден.`);
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!(key in json)) return ctx.reply(`❌ Ключ "${key}" не найден.`);
    await ctx.reply(`🔎 ${key} = ${JSON.stringify(json[key])}`);
  } catch (err) {
    console.error('/get error:', err);
    try { await ctx.reply('❌ Ошибка при чтении JSON.'); } catch {}
  }
});

// /set
bot.command('set', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const filename = args[0], key = args[1], valueRaw = args.slice(2).join(' ');
  if (!filename || !key || !valueRaw) return ctx.reply('⚠️ Используй: /set <имя файла> <ключ> <значение>');
  if (!allowedFile(filename)) return ctx.reply('❌ Доступ к этому файлу запрещён.');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return ctx.reply(`❌ Файл "${filename}" не найден.`);
  let value = valueRaw;
  try { value = JSON.parse(valueRaw); } catch {}
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    json[key] = value;
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
    if (path.resolve(filePath) === path.resolve(CONFIG_PATH)) {
      config = loadConfig();
    }
    await ctx.reply(`✅ Установлено: ${key} = ${JSON.stringify(value)}`);
  } catch (err) {
    console.error('/set error:', err);
    try { await ctx.reply('❌ Ошибка при обновлении JSON.'); } catch {}
  }
});

// /rm
bot.command('rm', async (ctx) => {
  const [filename, key] = ctx.message.text.split(' ').slice(1);
  if (!filename || !key) return ctx.reply('⚠️ Используй: /rm <имя файла> <ключ>');
  if (!allowedFile(filename)) return ctx.reply('❌ Доступ к этому файлу запрещён.');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return ctx.reply(`❌ Файл "${filename}" не найден.`);
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!(key in json)) return ctx.reply(`❌ Ключ "${key}" не найден.`);
    delete json[key];
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
    if (path.resolve(filePath) === path.resolve(CONFIG_PATH)) {
      config = loadConfig();
    }
    await ctx.reply(`🗑 Ключ "${key}" удалён.`);
  } catch (err) {
    console.error('/rm error:', err);
    try { await ctx.reply('❌ Ошибка при удалении ключа.'); } catch {}
  }
});

// /clean
bot.command('clean', async (ctx) => {
  const filename = ctx.message.text.split(' ')[1];
  if (!filename) return ctx.reply('⚠️ Используй: /clean <имя файла>');
  if (!allowedFile(filename)) return ctx.reply('❌ Доступ к этому файлу запрещён.');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return ctx.reply(`❌ Файл "${filename}" не найден.`);
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  pendingConfirmations[ctx.chat.id] = { filename, code, userId: ctx.from.id };
  try {
    await ctx.reply(`⚠️ Подтверди очистку файла "${filename}".\nОтправь код: \`${code}\``, { parse_mode: 'Markdown' });
  } catch {}
});

// Подтверждение очистки (проверяется белый список и пользователь)
bot.on('text', async (ctx) => {
  const state = pendingConfirmations[ctx.chat.id];
  if (!state) return;
  // Проверяем, что сообщение пришло от того же пользователя, что запросил очистку
  if (ctx.from.id !== state.userId) return;

  try {
    if (ctx.message.text.trim() === state.code) {
      const filePath = path.join(WORK_DIR, state.filename);
      if (!allowedFile(state.filename)) {
        await ctx.reply('❌ Доступ к этому файлу запрещён.');
      } else {
        if (path.extname(state.filename) === '.json') {
          fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
        } else {
          fs.writeFileSync(filePath, '');
        }
        if (path.resolve(filePath) === path.resolve(CONFIG_PATH)) {
          config = loadConfig();
        }
        await ctx.reply(`✅ Файл "${state.filename}" очищен.`);
      }
    } else {
      await ctx.reply('❌ Код не совпадает. Очистка отменена.');
    }
  } catch (err) {
    console.error('clean confirm error:', err);
    try { await ctx.reply('❌ Ошибка при очистке файла.'); } catch {}
  }
  delete pendingConfirmations[ctx.chat.id];
});

// /reboot
bot.command('reboot', async (ctx) => {
  if (!isAuthorized(ctx.from.id)) {
    try { await ctx.reply('❌ Нет прав на выполнение команды.'); } catch {}
    return;
  }
  try {
    await ctx.reply('⚠️ Перезагрузка Raspberry Pi...');
    exec('sudo reboot', (err) => {
      if (err) {
        console.error('/reboot error:', err);
        ctx.reply(`❌ Не удалось: ${err.message}`).catch(() => {});
      }
    });
  } catch (e) {
    console.error('/reboot command error:', e);
  }
});

// /log
bot.command('log', async (ctx) => {
  if (!fs.existsSync(LOGS_DIR)) {
    try { await ctx.reply('❌ Папка logs не найдена.'); } catch {}
    return;
  }
  try {
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
    if (!files.length) {
      await ctx.reply('❌ Логи отсутствуют.');
      return;
    }
    const latestLog = files.sort().reverse()[0];
    await ctx.replyWithDocument({ source: path.join(LOGS_DIR, latestLog) });
  } catch (err) {
    console.error('/log error:', err);
    try { await ctx.reply('❌ Ошибка при получении логов.'); } catch {}
  }
});

// /resmon
bot.command('resmon', async (ctx) => {
  if (!isAuthorized(ctx.from.id)) {
    try { await ctx.reply('❌ Нет прав на выполнение команды.'); } catch {}
    return;
  }

  const chatId = ctx.chat.id;

  let sent;
  try {
    sent = await ctx.reply('📊 Загружаю данные...', Markup.inlineKeyboard([
      [Markup.button.callback('⏹ Завершить', `stopresmon_${chatId}`)]
    ]));
  } catch (e) {
    console.error('resmon initial reply error:', e);
    try { await ctx.reply('❌ Не удалось начать мониторинг.'); } catch {}
    return;
  }

  resmonState[chatId] = {
    message_id: sent.message_id,
    lastText: ''
  };

  const updateStats = async () => {
    try {
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpuLoad = (os.loadavg()[0] * 100) / os.cpus().length;
      let temp = 'N/A';
      try {
        const rawTemp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf-8');
        temp = (parseInt(rawTemp) / 1000).toFixed(1) + '°C';
      } catch {}

      getDiskUsage((err, disk) => {
        let diskLine = 'N/A';
        if (!err && disk) {
          const totalMB = (disk.totalKB / 1024).toFixed(1);
          const usedMB = (disk.usedKB / 1024).toFixed(1);
          diskLine = `${usedMB} / ${totalMB} MB (${disk.usePercent})`;
        }

        const newText =
`📊 Мониторинг ресурсов:
🖥 CPU: ${cpuLoad.toFixed(1)}%
💾 RAM: ${(usedMem / 1024 / 1024).toFixed(1)} / ${(totalMem / 1024 / 1024).toFixed(1)} МБ
📦 RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} МБ
💽 Disk: ${diskLine}
🌡 Температура: ${temp}
⏳ Аптайм системы: ${(os.uptime() / 60).toFixed(1)} мин
⚙️ Node: ${process.version}`;

        const state = resmonState[chatId];
        if (!state) return;

        if (newText !== state.lastText) {
          state.lastText = newText;
          bot.telegram.editMessageText(
            chatId,
            state.message_id,
            null,
            newText,
            { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⏹ Завершить', `stopresmon_${chatId}`)]]) }
          ).catch(err => {
            const desc = err?.response?.description || err?.message || '';
            if (!/message is not modified/i.test(desc)) {
              console.error('editMessageText error:', err);
            }
          });
        }
      });
    } catch (err) {
      console.error('updateStats error:', err);
    }
  };

  resmonIntervals[chatId] = setInterval(updateStats, 1000);
  setImmediate(updateStats);
});

// Критическое исправление регулярки - ловим и отрицательные chatId
bot.action(/stopresmon_(-?\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  if (!isAuthorized(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Нет прав', { show_alert: true }).catch(() => {});
    return;
  }

  try {
    if (resmonIntervals[chatId]) {
      clearInterval(resmonIntervals[chatId]);
      delete resmonIntervals[chatId];
    }
    if (resmonState[chatId]) {
      await bot.telegram.editMessageText(chatId, resmonState[chatId].message_id, null, '✅ Мониторинг завершён.');
      delete resmonState[chatId];
    }
    await ctx.answerCbQuery('Мониторинг остановлен');
  } catch (err) {
    console.error('stopresmon error:', err);
  }
});

bot.launch().then(() => {
  console.log('🤖 Бот запущен.');
}).catch(err => {
  console.error('Ошибка запуска бота:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
