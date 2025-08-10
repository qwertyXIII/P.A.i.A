#!/bin/bash
# Убить процессы admin.js и index.js, перезапустить их через pm2 или любой другой менеджер процессов

pm2 restart admin
pm2 restart index

echo "Скрипты перезапущены."