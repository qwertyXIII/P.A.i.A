console.clear();

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Пути
const WORK_DIR = __dirname;
const CONFIG_PATH = path.join(WORK_DIR, 'config.json');
const LOGS_DIR = path.join(WORK_DIR, 'logs');
const HISTORY_PATH = path.join(WORK_DIR, 'history.json');

// Загружаем конфиг
if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Файл config.json не найден');
    process.exit(1);
}
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Проверка на админа
function isAdmin(ctx) {
    return config.ADMINS.includes(ctx.from.id);
}

// Бот
const bot = new Telegraf(config.BOT_TOKEN);

// Авторизационный middleware
bot.use((ctx, next) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Доступ запрещён');
    }
    return next();
});

// /start
bot.start((ctx) => {
    ctx.reply(
        `📜 Список команд:
        
/start - список команд
/resmon - мониторинг системы
/ls - список файлов
/show - показать файл
/cleancontext - очистить history.json
/log - последний лог
/reboot - перезагрузить RPI
/edit - редактировать .json файл`,
        { parse_mode: 'Markdown' }
    );
});

// /resmon
bot.command('resmon', async (ctx) => {
    let running = true;

    const updateMessage = async (messageId) => {
        while (running) {
            const load = os.loadavg().map(n => n.toFixed(2)).join(', ');
            const mem = (os.totalmem() - os.freemem()) / os.totalmem() * 100;
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    messageId,
                    null,
                    `📊 *Мониторинг системы*\nCPU Load: ${load}\nRAM Usage: ${mem.toFixed(2)}%`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⏹ Остановить', callback_data: 'stop_resmon' }]]
                        }
                    }
                );
            } catch (err) {}
            await new Promise(r => setTimeout(r, 2000));
        }
    };

    const msg = await ctx.reply('Запуск мониторинга...', {
        reply_markup: {
            inline_keyboard: [[{ text: '⏹ Остановить', callback_data: 'stop_resmon' }]]
        }
    });

    updateMessage(msg.message_id);

    bot.action('stop_resmon', (actionCtx) => {
        running = false;
        actionCtx.editMessageText('✅ Мониторинг остановлен');
    });
});

// /ls
bot.command('ls', (ctx) => {
    const ignore = config.IGNORE_DIRS || [];
    const files = fs.readdirSync(WORK_DIR)
        .filter(f => !ignore.includes(f))
        .join('\n');
    ctx.reply(`📂 Файлы и папки:\n${files}`);
});

// /show
bot.command('show', (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('⚠ Укажите имя файла: /show filename');

    const filePath = path.join(WORK_DIR, parts[1]);
    if (!fs.existsSync(filePath)) return ctx.reply('❌ Файл не найден');

    const content = fs.readFileSync(filePath, 'utf8');

    if (content.length > 4000) {
        ctx.replyWithDocument({ source: filePath });
    } else {
        ctx.reply(`📄 Содержимое файла:\n\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' });
    }
});

// /cleancontext
bot.command('cleancontext', (ctx) => {
    fs.writeFileSync(HISTORY_PATH, '{}');
    ctx.reply('✅ Файл history.json очищен');
});

// /log
bot.command('log', (ctx) => {
    if (!fs.existsSync(LOGS_DIR)) return ctx.reply('❌ Папка /logs не найдена');

    const logs = fs.readdirSync(LOGS_DIR).sort((a, b) => {
        return fs.statSync(path.join(LOGS_DIR, b)).mtime - fs.statSync(path.join(LOGS_DIR, a)).mtime;
    });

    if (logs.length === 0) return ctx.reply('❌ Логов нет');

    const lastLog = path.join(LOGS_DIR, logs[0]);
    const content = fs.readFileSync(lastLog, 'utf8');

    if (content.length > 4000) {
        ctx.replyWithDocument({ source: lastLog });
    } else {
        ctx.reply(`📄 Лог:\n\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' });
    }
});

// /reboot
bot.command('reboot', (ctx) => {
    ctx.reply('♻ Перезагрузка...', { parse_mode: 'Markdown' });
    exec('sudo reboot', (err) => {
        if (err) ctx.reply(`❌ Ошибка: ${err.message}`);
    });
});

// /edit
bot.command('edit', (ctx) => {
    const jsonFiles = fs.readdirSync(WORK_DIR).filter(f => f.endsWith('.json'));

    ctx.reply('📂 Выберите файл для редактирования:', {
        reply_markup: {
            inline_keyboard: jsonFiles.map(f => [{ text: f, callback_data: `edit_file:${f}` }])
        }
    });
});

bot.action(/^edit_file:(.+)$/, (ctx) => {
    const file = ctx.match[1];
    const filePath = path.join(WORK_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    ctx.session = { editFile: file, filePath, data };

    ctx.editMessageText(`🔑 Выберите ключ для редактирования в файле *${file}*:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: Object.keys(data).map(k => [{ text: k, callback_data: `edit_key:${k}` }])
        }
    });
});

bot.action(/^edit_key:(.+)$/, (ctx) => {
    const key = ctx.match[1];
    ctx.session.editKey = key;
    ctx.editMessageText(`✏ Введите новое значение для ключа *${key}*:`, { parse_mode: 'Markdown' });
});

bot.on('text', (ctx) => {
    if (ctx.session && ctx.session.editKey) {
        const { filePath, data, editKey } = ctx.session;
        data[editKey] = ctx.message.text;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        ctx.reply(`✅ Ключ *${editKey}* обновлён`, { parse_mode: 'Markdown' });
        ctx.session = null;
    }
});

bot.launch();
console.log('✅ Бот запущен');