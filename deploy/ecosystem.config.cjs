// pm2-конфиг админки ЖКС для Beget VPS (запуск: pm2 start deploy/ecosystem.config.cjs)
module.exports = {
  apps: [{
    name: 'jks-admin',
    script: 'server.mjs',
    cwd: '../admin',               // относительно этого файла: ../admin/server.mjs
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',           // наружу смотрит только nginx
      PORT: 4777,
      HTTPS: '1',                  // secure-cookie, за nginx с certbot
      REBUILD: '1',                // после сохранения пересобирать сайт на месте
      GIT_PUSH: '1',               // и пушить в GitHub как бэкап (нужен PAT на сервере)
      SESSION_SECRET: 'ОБЯЗАТЕЛЬНО_ЗАМЕНИТЬ_НА_ДЛИННУЮ_СЛУЧАЙНУЮ_СТРОКУ',
    },
    max_memory_restart: '400M',
    restart_delay: 3000,
  }],
};
