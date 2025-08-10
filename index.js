console.clear();

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// === Пути к файлам (относительно текущей директории скрипта) ===
const baseDir = __dirname;
const configPath = path.join(baseDir, 'config.json');       // Файл с настройками: apiId, apiHash, API
const stringSessionFile = path.join(baseDir, 'session.txt'); // Файл для хранения сессии Telegram
const historyPath = path.join(baseDir, 'history.json');      // Файл с историей переписки пользователей
const dataPath = path.join(baseDir, 'data.json');            // Файл с дополнительными данными для LLM
const logsDir = path.join(baseDir, 'logs');                  // Папка для логов

// === Создаём папку для логов, если её нет ===
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// === Функция для получения имени файла лога по дате ===
function getLogFilePath() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // формат YYYY-MM-DD
    return path.join(logsDir, `${dateStr}.log`);
}

// === Универсальная функция логирования с выводом в файл и консоль ===
function logWithDate(...args) {
    const now = new Date();
    const timeStr = now.toISOString();
    const logFile = getLogFilePath();

    // Форматируем сообщения в строку
    const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        // Безопасный JSON.stringify с заменой circular references
        try {
            return JSON.stringify(arg, null, 2);
        } catch {
            return '[Cannot stringify object]';
        }
    }).join(' ') + '\n';

    // Запись в файл асинхронно, без блокировки
    fs.appendFile(logFile, `[${timeStr}] ${message}`, (err) => {
        if (err) {
            console.error(`[${timeStr}] Ошибка записи в лог файл:`, err);
        }
    });

    // Одновременно вывод в консоль
    console.log(`[${timeStr}]`, ...args);
}

// === Загрузка конфига из config.json ===
function loadConfig() {
    if (!fs.existsSync(configPath)) {
        logWithDate('config.json не найден. Создайте файл с apiId, apiHash и API.');
        process.exit(1);
    }
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        logWithDate('Ошибка чтения config.json:', e);
        process.exit(1);
    }
}

const config = loadConfig();
const { apiId, apiHash, API } = config;

if (!apiId || !apiHash || !API) {
    logWithDate('В config.json должны быть указаны apiId, apiHash и API.');
    process.exit(1);
}

// Временные буферы для агрегации сообщений пользователей перед отправкой на обработку
let userBuffers = new Map();

// === Функции работы с историей переписки ===

function loadHistory() {
    if (fs.existsSync(historyPath)) {
        try {
            const data = fs.readFileSync(historyPath, 'utf8');
            logWithDate('Загрузка истории из файла history.json');
            return JSON.parse(data);
        } catch (e) {
            logWithDate('Ошибка чтения history.json, создаётся пустая история:', e);
            return {};
        }
    }
    logWithDate('Файл history.json отсутствует, создаётся пустая история');
    return {};
}

function saveHistory(history) {
    try {
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
        logWithDate('История успешно сохранена');
    } catch (e) {
        logWithDate('Ошибка сохранения history.json:', e);
    }
}

function updateUserHistory(history, userId, role, content) {
    if (!history[userId]) {
        history[userId] = { messages: [], lastActive: Date.now() };
        logWithDate(`Создана новая история для пользователя ${userId}`);
    }
    history[userId].messages.push({ role, content });
    history[userId].lastActive = Date.now();

    if (history[userId].messages.length > 20) {
        history[userId].messages = history[userId].messages.slice(-20);
        logWithDate(`История пользователя ${userId} обрезана до 20 последних сообщений`);
    }

    saveHistory(history);
}

function pruneUserHistoryIfExpired(history, userId, ttlMs) {
    const now = Date.now();
    if (history[userId] && (now - history[userId].lastActive > ttlMs)) {
        logWithDate(`История пользователя ${userId} устарела (неактивен более ${ttlMs} мс), удаляю`);
        delete history[userId];
        saveHistory(history);
    }
}

// === Основная функция запуска бота ===
async function main() {
    logWithDate('Запуск бота...');

    let stringSession = '';
    if (fs.existsSync(stringSessionFile)) {
        stringSession = fs.readFileSync(stringSessionFile, 'utf8');
        logWithDate('Сессия загружена из файла');
    } else {
        logWithDate('Файл сессии не найден, будет выполнен новый вход');
    }

    const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        await client.start({
            phoneNumber: async () => {
                logWithDate('Запрос номера телефона для авторизации');
                return await input.text('Введите номер телефона: ');
            },
            password: async () => {
                logWithDate('Запрос двухфакторного пароля');
                return await input.text('Введите двухфакторный пароль: ');
            },
            phoneCode: async () => {
                logWithDate('Запрос кода из SMS');
                return await input.text('Введите код из SMS: ');
            },
            onError: (err) => logWithDate('Ошибка авторизации:', err),
        });
    } catch (err) {
        logWithDate('Ошибка при старте клиента:', err);
        process.exit(1);
    }

    logWithDate('User-bot успешно запущен');
    fs.writeFileSync(stringSessionFile, client.session.save());
    logWithDate('Сессия сохранена в файл');

    // Получаем свой ID, чтобы игнорировать собственные сообщения
    const me = await client.getMe();
    const myId = me.id.value;
    logWithDate(`Собственный ID пользователя: ${myId}`);

    // === Обработчик входящих сообщений ===
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message || !message.message) {
                logWithDate('Пропущено сообщение без текста');
                return;
            }

            const sender = await message.getSender();

            if (!sender) {
                logWithDate('Не удалось получить отправителя сообщения');
                return;
            }

            // Игнорируем сообщения от ботов
            if (sender.bot) {
                logWithDate(`Игнорировано сообщение от бота с ID ${sender.id?.value}`);
                return;
            }

            // Игнорируем собственные сообщения
            if (sender.id.value === myId) {
                logWithDate('Игнорируем собственное сообщение');
                return;
            }
            
            const fullName = [sender.firstName, sender.lastName, sender.username ? `@${sender.username}` : null].filter(Boolean).join(' ');
            const userId = sender.id.value;
            const text = message.message;

            logWithDate(`Получено сообщение от ${userId}: "${text}"`);

            if (!userBuffers.has(userId)) {
                userBuffers.set(userId, { messages: [], timeout: null });
                logWithDate(`Создан новый буфер сообщений для пользователя ${userId}`);
            }
            const buffer = userBuffers.get(userId);
            buffer.messages.push(text);

            if (buffer.timeout) clearTimeout(buffer.timeout);

            buffer.timeout = setTimeout(async () => {
                try {
                    let history = loadHistory();
                    pruneUserHistoryIfExpired(history, userId, 3600000); // 1 час

                    const aggregatedMessage = buffer.messages.join(' ');
                    userBuffers.delete(userId);

                    logWithDate(`Агрегированное сообщение для пользователя ${userId}: "${aggregatedMessage}"`);

                    let jsonData = {};
                    try {
                        jsonData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
                        logWithDate('Дополнительные данные для LLM загружены из data.json');
                    } catch (err) {
                        logWithDate('Ошибка чтения data.json:', err);
                    }

                    updateUserHistory(history, userId, 'user', aggregatedMessage);

                    // Отправка запроса к LLM API
                    logWithDate(`Отправка запроса к API для пользователя ${userId}`);
                    const response = await axios.post(
                        API,
                        {
                            model: "openai/gpt-oss-20b",
                            messages: [
                                {
                                    role: "user",
                                    content: `сообщение от ${fullName}: ${aggregatedMessage}`
                                },
                                {
                                    role: "system",
                                    content: "JSON с данными: " + JSON.stringify(jsonData, null, 2)
                                },
                                {
                                    role: "system",
                                    content: "последние 10 сообщений в чате: " +
                                             JSON.stringify((history[userId]?.messages || []).slice(-10), null, 2)
                                }
                            ],
                            stream: false,
                        },
                        { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
                    );

                    const replyText = response.data?.choices?.[0]?.message?.content || '🤔 Ответ пустой';

                    logWithDate(`Ответ от LLM для пользователя ${userId}: "${replyText}"`);
                    updateUserHistory(history, userId, 'assistant', replyText);

                    await client.sendMessage(message.chatId, { message: replyText, replyTo: message.id });
                    logWithDate(`Ответ отправлен пользователю ${userId}`);
                } catch (err) {
                    logWithDate(`Ошибка обработки сообщения пользователя ${userId}:`, err.message || err);
                    await client.sendMessage(message.chatId, { message: 'Ошибка при обработке запроса.' });
                }
            }, 1000);
        } catch (outerErr) {
            logWithDate('Внешняя ошибка обработчика сообщений:', outerErr);
        }
    }, new NewMessage({}));

    process.once('SIGINT', () => {
        logWithDate('Завершение работы по сигналу SIGINT...');
        client.disconnect();
        process.exit(0);
    });
}

main();