module.exports = {
  apps: [{
    name: 'fuglehund',
    script: 'server.js',
    cwd: '/var/www/fuglehundprove',
    env: {
      NODE_ENV: 'production',
      PORT: 8889
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    error_file: '/var/log/fuglehund/error.log',
    out_file: '/var/log/fuglehund/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
};
