module.exports = {
  apps: [
    {
      name: "shog-agent",
      script: "./node_modules/.bin/tsx",
      args: "src/index.ts",
      cwd: "/Users/maoxiongyu/Code/shog-agent",
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai",
      },
    },
    {
      name: "shog-memory-maintenance",
      script: "./node_modules/.bin/tsx",
      args: "src/memory-maintenance.ts",
      cwd: "/Users/maoxiongyu/Code/shog-agent",
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai",
        MODEL: "minimax-cn/MiniMax-M2.7",
      },
    },
  ],
};
