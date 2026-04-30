module.exports = {
  apps: [{
    name: 'shog-agent',
    script: './node_modules/.bin/tsx',
    args: 'src/index.ts',
    cwd: '/Users/maoxiongyu/Code/shog-agent',
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
    },
  }],
};
