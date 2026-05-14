/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // 生产环境 standalone 输出
  transpilePackages: ["@tech-mate/core", "@tech-mate/agent-langgraph", "@tech-mate/scheduler", "@tech-mate/database"],
  // better-sqlite3 是 native module (.node binding)，必须作为服务端外部包不被打包
  // 否则 webpack 会破坏 langgraph SqliteSaver 内部对 better-sqlite3 的 require 解析
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "@langchain/langgraph"],
  },
  webpack: (config, { isServer }) => {
    // 排除 chromadb 和 undici
    // undici 6.x 在源码里用了 webpack 不支持的私有字段语法（#target），必须当外部模块加载
    config.externals = config.externals || [];
    config.externals.push(({ request }, callback) => {
      if (request && (request.includes('chromadb') || request.includes('chroma'))) {
        return callback(null, 'commonjs ' + request);
      }
      if (request === 'undici' || (request && request.startsWith('undici/'))) {
        return callback(null, 'commonjs ' + request);
      }
      // better-sqlite3 是 native 绑定，必须当作 commonjs 外部模块
      if (request === 'better-sqlite3') {
        return callback(null, 'commonjs ' + request);
      }
      // langgraph 的 SqliteSaver 内部 require('better-sqlite3')，整个 langgraph 走 external
      if (request && (request === '@langchain/langgraph' || request.startsWith('@langchain/langgraph/'))) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    });

    // 添加别名来排除chromadb
    config.resolve.alias = {
      ...config.resolve.alias,
      'chromadb': false,
      'chromadb-default-embed': false,
    };

    return config;
  },
};

module.exports = nextConfig;
