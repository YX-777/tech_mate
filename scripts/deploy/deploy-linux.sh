#!/bin/bash
# TechMate Linux 一键部署脚本
# 包含：环境初始化 + 项目初始化 + 启动服务
# 使用方法：sudo bash deploy-linux.sh

set -e

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    echo "❌ 请使用 root 权限运行此脚本"
    echo "   sudo bash deploy-linux.sh"
    exit 1
fi

# 自动检测项目目录（脚本位于 scripts/deploy/）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "项目目录：$PROJECT_DIR"

echo "=========================================="
echo "  TechMate 一键部署"
echo "=========================================="

# ========== 1. 环境初始化 ==========
echo ""
echo "1️⃣  环境初始化..."

# 更新系统
apt update && apt upgrade -y
apt install -y curl git build-essential sqlite3

# 安装 Node.js 18
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt install -y nodejs
fi
echo "   Node.js: $(node -v)"

# 安装 pnpm
if ! command -v pnpm &> /dev/null; then
    npm install -g pnpm
fi
echo "   pnpm: $(pnpm -v)"

# 安装 Python
apt install -y python3 python3-pip
echo "   Python: $(python3 --version)"

# 安装 ChromaDB（Ubuntu 23.04+ 需要 --break-system-packages）
# --ignore-installed 跳过卸载系统包（如 rich、click、bcrypt 等）
pip3 install --break-system-packages --ignore-installed chromadb
echo "   ChromaDB: 已安装"

# 配置 swap（内存不足时）
TOTAL_MEM=$(free -m | awk '/^Mem:/ {print $2}')
if [ $TOTAL_MEM -lt 2048 ] && [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile none swap sw 0 0" >> /etc/fstab
    echo "   Swap: 2GB 已创建"
fi

# ========== 2. 项目初始化 ==========
echo ""
echo "2️⃣  项目初始化..."

cd "$PROJECT_DIR"

# 清理旧依赖
rm -rf node_modules packages/*/node_modules pnpm-lock.yaml 2>/dev/null || true
rm -rf packages/web/.next 2>/dev/null || true

# 安装依赖
pnpm install
echo "   依赖已安装"

# 强制重建 better-sqlite3 native binding（langgraph SqliteSaver 依赖）
# pnpm 10+ 默认拦截 install scripts，靠 root package.json 的 onlyBuiltDependencies 白名单放行
# 这里再显式 rebuild 一次兜底，确保 .node binding 生成
echo "   🔨 重建 better-sqlite3 native binding..."
pnpm rebuild better-sqlite3 2>&1 | tail -3 || true
if find node_modules/.pnpm/better-sqlite3* -name "better_sqlite3.node" 2>/dev/null | head -1 | grep -q .; then
  echo "   ✅ better-sqlite3 native binding OK"
else
  echo "   ⚠️  better-sqlite3 native binding 缺失，LangGraph 会 fallback 到 MemorySaver"
fi

# 生成 Prisma Client
cd packages/database && npx prisma generate && cd ..
echo "   Prisma Client 已生成"

# 构建项目（增加内存限制）
NODE_OPTIONS="--max-old-space-size=4096" pnpm -r build
echo "   项目已构建"

# 初始化数据库
cd packages/database && npx prisma db push --force-reset && cd ..
mkdir -p packages/web/data
cp packages/database/prisma/data/tech-mate.db packages/web/data/tech-mate.db
sqlite3 packages/web/data/tech-mate.db "INSERT INTO users (id, created_at, updated_at) VALUES ('default-user', datetime('now'), datetime('now'));"
echo "   数据库已初始化"

# ========== 3. 启动服务 ==========
echo ""
echo "3️⃣  启动服务..."

# 创建数据目录
mkdir -p data/chroma

# 创建 systemd 服务（后台运行）
# ChromaDB 服务（使用 Python 模块启动，避免 CLI 路径问题）
cat > /etc/systemd/system/techmate-chroma.service << EOF
[Unit]
Description=TechMate ChromaDB Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/python3 -m chromadb run --host localhost --port 8000 --path ./data/chroma
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Web 服务
cat > /etc/systemd/system/techmate-web.service << EOF
[Unit]
Description=TechMate Web Server
After=network.target techmate-chroma.service

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR/packages/web
Environment=DATABASE_URL=file:./data/tech-mate.db
Environment=NODE_OPTIONS=--max-old-space-size=4096
ExecStart=/usr/bin/node ../../node_modules/next/dist/bin/next start -H 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 启用并启动服务
systemctl daemon-reload
systemctl enable techmate-chroma techmate-web
systemctl start techmate-chroma
sleep 5  # 等待 ChromaDB 启动
systemctl start techmate-web

echo "   服务已启动"

# ========== 4. 完成提示 ==========
echo ""
echo "=========================================="
echo "  ✅ 部署完成！"
echo "=========================================="
echo ""
echo "服务地址："
echo "   - Web 服务: http://服务器IP:3000"
echo "   - ChromaDB: http://服务器IP:8000"
echo ""
echo "常用命令："
echo "   查看状态: systemctl status techmate-web techmate-chroma"
echo "   查看日志: journalctl -u techmate-web -f"
echo "   重启服务: systemctl restart techmate-web"
echo "   更新代码: bash scripts/deploy/update-server.sh"
echo ""