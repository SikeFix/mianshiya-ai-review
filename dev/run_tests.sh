#!/usr/bin/env bash
#
# 跑全部测试。
#
#   调用方式：bash dev/run_tests.sh
#
# 会先起一个本地假的 AI 服务（说 OpenAI 的 SSE 协议），测试用它验证整条对话链路，
# 不消耗任何真实 API 额度。跑完自动收掉。

set -uo pipefail

cd "$(dirname "$0")/.."

PORT=8787
MOCK_LOG=$(mktemp -t msy-mock)

cleanup() {
  if [[ -n "${MOCK_PID:-}" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f "$MOCK_LOG"
}
trap cleanup EXIT

# 已经有 mock 服务在跑就直接用，避免端口冲突
if curl -sf -o /dev/null "http://localhost:${PORT}/v1/models" 2>/dev/null; then
  echo "复用已在运行的 mock 服务（端口 ${PORT}）"
else
  echo "启动 mock AI 服务（端口 ${PORT}）…"
  node dev/mock-openai-server.js > "$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 25); do
    curl -sf -o /dev/null "http://localhost:${PORT}/v1/models" 2>/dev/null && break
    sleep 0.2
  done
  if ! curl -sf -o /dev/null "http://localhost:${PORT}/v1/models" 2>/dev/null; then
    echo "mock 服务起不来，日志："
    cat "$MOCK_LOG"
    exit 1
  fi
fi

FAILED=0

# 夹具是抓下来的真实页面快照（体积不小，也没必要进版本库），
# 缺了就现场抓一份，让新克隆下来的人直接能跑
if ! compgen -G "dev/fixtures/*.html" > /dev/null; then
  echo
  echo "缺少页面夹具，先抓一份（需要能访问 www.mianshiya.com）…"
  if ! python3 dev/capture_fixture.py; then
    echo "抓取失败。要么连不上面试鸭，要么站点结构变了。"
    exit 1
  fi
fi

for suite in test_extract test_srs test_voice e2e_test; do
  echo
  echo "══════════════════════════════════════════════════════════"
  echo "  $suite"
  echo "══════════════════════════════════════════════════════════"
  if ! python3 "dev/${suite}.py"; then
    FAILED=1
  fi
done

echo
if [[ $FAILED -eq 0 ]]; then
  echo "全部测试通过。"
else
  echo "有测试失败，见上面的输出。"
fi
exit $FAILED
