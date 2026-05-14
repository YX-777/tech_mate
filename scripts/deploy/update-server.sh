#!/bin/bash
# TechMate 服务器更新脚本（Linux）
# 使用方法：bash update-server.sh

set -e

echo "=========================================="
echo "  TechMate 服务器更新"
echo "=========================================="

cd "$(dirname "$0")/../.."

# 1. 拉取最新代码（带超时+重试，防国内网络卡死）
echo ""
echo "1️⃣  拉取最新代码..."
PULL_OK=0
for i in 1 2 3; do
  if timeout 90 git pull; then
    PULL_OK=1
    break
  fi
  echo "   第 $i 次失败（超时或网络中断），10s 后重试..."
  sleep 10
done
if [ $PULL_OK -eq 0 ]; then
  echo "   ❌ git pull 三次都失败，建议："
  echo "      1) 检查网络：ping github.com"
  echo "      2) 改 origin 走 ghproxy："
  echo "         git remote set-url origin https://ghproxy.com/\$(git remote get-url origin)"
  echo "      3) 或在本地跑 deploy-from-local.sh 跳过服务端 git pull"
  exit 1
fi

# 2. 停止服务释放内存（2GB 机器关键，腾出 400-800MB 给后续 build）
echo ""
echo "2️⃣  停止服务释放内存..."
for svc in techmate-web techmate-chroma; do
  if systemctl is-active "$svc" &>/dev/null; then
    systemctl stop "$svc" && echo "   ⏸️  $svc 已停止"
  else
    echo "   ℹ️  $svc 未运行，跳过"
  fi
done
# 兜底：kill 掉非 systemd 拉起的 node/next/python chromadb 进程
pkill -f "next start" 2>/dev/null || true
pkill -f "chromadb.cli" 2>/dev/null || true
sleep 2
free -h 2>/dev/null | head -3 || true

# 3. 清理旧依赖（保留 pnpm-lock.yaml 以保证 workspace symlink 一致性）
echo ""
echo "3️⃣  清理旧依赖..."
rm -rf node_modules packages/*/node_modules 2>/dev/null || true
rm -rf packages/web/.next 2>/dev/null || true
rm -rf packages/*/dist 2>/dev/null || true   # 强制重建，避免旧 dist 残留导致新导出丢失

# 4. 安装依赖（用 lockfile 还原确定依赖树）
echo ""
echo "4️⃣  安装依赖..."
pnpm install

# 4.0 强制重建 better-sqlite3 native binding（langgraph SqliteSaver 依赖）
#     pnpm 10+ 默认拦截 install scripts，靠 root package.json 的
#     pnpm.onlyBuiltDependencies 白名单放行。这里再显式 rebuild 一次兜底，
#     避免架构变化（如 x86→arm 迁移）或缺失 build-essential 导致 .node 没生成。
#     缺了 native binding 不会让服务挂（已 try/catch fallback 到 MemorySaver），
#     但 LangGraph 真持久化能力会退化，所以必须保 native build 成功
echo "   🔨 重建 better-sqlite3 native binding..."
if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
  echo "   ⚠️  缺 build-essential，尝试安装..."
  apt install -y build-essential python3 || true
fi
pnpm rebuild better-sqlite3 2>&1 | tail -5 || true
# 校验：native binding 文件确实存在
BSQLITE_BINDING=$(find node_modules/.pnpm/better-sqlite3* -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -n "$BSQLITE_BINDING" ]; then
  echo "   ✅ better-sqlite3 native binding OK: $BSQLITE_BINDING"
else
  echo "   ⚠️  better-sqlite3 native binding 缺失"
  echo "      LangGraph 会 fallback 到 MemorySaver（功能可用但不持久化）"
  echo "      手动修复: cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install"
fi

# 4.1 兜底校验 workspace symlink（Next.js transpilePackages 需要直接读源码）
echo ""
echo "   🔍 校验 workspace symlink..."
for pkg in scheduler agent-langgraph rag-engine database; do
  link="packages/$pkg/node_modules/@tech-mate/core"
  if [ ! -e "$link" ]; then
    echo "   ⚠️  $link 缺失，手动补建"
    mkdir -p "packages/$pkg/node_modules/@tech-mate"
    ln -sfn "../../../core" "$link"
  fi
done
# scheduler 还需要 database / agent-langgraph
for dep in database agent-langgraph mcp-xiaohongshu; do
  link="packages/scheduler/node_modules/@tech-mate/$dep"
  if [ ! -e "$link" ]; then
    echo "   ⚠️  $link 缺失，手动补建"
    mkdir -p "packages/scheduler/node_modules/@tech-mate"
    ln -sfn "../../../$dep" "$link"
  fi
done
echo "   ✅ workspace symlink 校验完成"

# 5. 生成 Prisma Client（用 pnpm --filter 避免 cd 出错）
echo ""
echo "5️⃣  生成 Prisma Client..."
pnpm --filter @tech-mate/database exec npx prisma generate

# 6. 编译所有 workspace 包（pnpm -r 自动按拓扑顺序，排除 web 让它单独走 step 7）
echo ""
echo "6️⃣  编译 TypeScript 包..."
pnpm -r --filter "!@tech-mate/web" build

# 7. 构建项目（内存限制）
echo ""
echo "7️⃣  构建项目..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter @tech-mate/web build

# 8. 启动服务（先 chroma 后 web，遵守 systemd After 依赖）
echo ""
echo "8️⃣  启动服务..."
START_ANY=0
for svc in techmate-chroma techmate-web; do
  if systemctl list-unit-files "$svc.service" &>/dev/null && \
     systemctl cat "$svc" &>/dev/null; then
    systemctl start "$svc" && echo "   ▶️  $svc 已启动"
    START_ANY=1
  fi
done
if [ $START_ANY -eq 0 ]; then
  echo "   提示：未检测到 systemd 服务，请手动启动：bash scripts/dev/start.sh"
fi

echo ""
echo "=========================================="
echo "  ✅ 更新完成！"
echo "=========================================="
echo ""
echo "常用命令："
echo "   查看状态: systemctl status techmate-web techmate-chroma"
echo "   查看日志: journalctl -u techmate-web -f"
echo "   手动启动: bash scripts/dev/start.sh"
echo ""