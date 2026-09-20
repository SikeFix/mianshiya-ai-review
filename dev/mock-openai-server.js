#!/usr/bin/env node
/**
 * 本地假的 OpenAI 兼容服务，只用于开发和测试，不花钱。
 *
 *   node dev/mock-openai-server.js            # 默认端口 8787
 *   PORT=9999 node dev/mock-openai-server.js
 *
 * 它做三件事：
 *   POST /v1/chat/completions        流式返回一段带 Markdown 的中文回答
 *   POST /v1/audio/transcriptions    返回固定的转写文本
 *   GET  /v1/models                  给「测试连接」用
 *
 * 在扩展设置页把 Base URL 填成 http://localhost:8787/v1 ，模型随便填，
 * 就能在完全不消耗 API 额度的情况下把整条链路跑通。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const CHUNK_DELAY = Number(process.env.CHUNK_DELAY || 22);

/** 一段故意包含各种 Markdown 结构的回答，方便验证渲染。 */
const SAMPLE = `**评分**：7/10

**答对的点**：
- 提到了「先查缓存再查数据库」这个基本流程
- 知道要处理缓存击穿

**漏掉的地方**：
1. 没有说清楚**互斥锁的粒度**问题
2. 漏了锁超时的处理，这在生产环境会导致死锁

## 关键实现

Redis 分布式锁的核心是 \`SET key value NX PX ttl\`：

\`\`\`java
public boolean tryLock(String key, String requestId, long ttlMs) {
    String result = jedis.set(key, requestId, "NX", "PX", ttlMs);
    return "OK".equals(result);
}
\`\`\`

> 注意：释放锁必须校验 requestId，否则会误删别人的锁。

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| SET NX PX | 简单、原子 | 不可重入 |
| Redisson | 可重入、看门狗续期 | 依赖额外组件 |

**更好的答法**：先说业务场景，再说选型理由，最后补一句锁续期和误删的风险。

---

下一题，选择题：

关于 Redis 分布式锁，下列说法**错误**的是？

A. SET key value NX PX 是一条原子命令，加锁和设过期一步到位

B. 释放锁时必须用 Lua 脚本先校验 value 再删除，否则可能误删别人的锁

C. 锁过期后业务还没执行完，Redisson 的看门狗会自动给锁续期

D. 只要设置了过期时间，就不需要再考虑锁重启丢失的问题

选好告诉我，我看看你掌握得怎么样。`;

const ASR_TEXT = 'Redis 实现分布式锁主要是用 SET 命令加上 NX 和 PX 参数，保证原子性，然后释放锁的时候要用 Lua 脚本校验 value，避免误删别人的锁。';

/** 最近一次收到的对话请求，测试用它断言发给模型的 system prompt 是否正确。 */
let lastRequest = null;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  console.log(`[mock] ${req.method} ${url.pathname}`);

  if (path.endsWith('/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }

  // 测试专用：回看最近一次收到的请求（含 system prompt）
  if (path === '/_last' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(lastRequest || { empty: true }));
    return;
  }

  if (path === '/_last' && req.method === 'DELETE') {
    lastRequest = null;
    res.writeHead(204).end();
    return;
  }

  if (path.endsWith('/audio/transcriptions') && req.method === 'POST') {
    // 把 multipart 请求体读完再回，避免客户端收到 connection reset
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: ASR_TEXT }));
    });
    return;
  }

  if (path.endsWith('/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* 忽略 */
      }

      lastRequest = { ...payload, _at: new Date().toISOString() };
      if (process.env.VERBOSE) {
        console.log(`  model=${payload.model} stream=${payload.stream} messages=${(payload.messages || []).length}`);
      }

      const auth = req.headers.authorization || '';
      // 故意留一个能测错误分支的开关：Key 填 bad-key 就返回 401
      if (auth.includes('bad-key')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }

      const lastUser = [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
      const echo = lastUser ? `收到你的回答（${String(lastUser.content).slice(0, 30)}…）。\n\n` : '';

      // 费曼模式下模仿真模型：讲完在最后一行打结束标记，
      // 让「讲完了 → 收尾动画」这条链路能被自动测到
      const sys = (payload.messages || []).find((m) => m.role === 'system')?.content || '';
      const isFeynman = sys.includes('费曼学习法');
      const reply = SAMPLE + (isFeynman ? '\n\n🎉 讲解完成' : '');

      if (!payload.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            model: payload.model || 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: echo + reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 400, total_tokens: 500 },
          })
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const id = 'mock-1';
      const full = echo + reply;

      // 先吐一段思考链。字段名故意用 `reasoning` 而不是 `reasoning_content` ——
      // vLLM 部署的 Qwen3 就是这么发的，插件必须两个都认，否则思考过程会整个丢掉。
      const think = '用户在问 Redis 分布式锁。先回忆一下 SET NX PX 的原子性，再想锁续期和误删的两个坑。';
      for (const piece of think.match(/[\s\S]{1,6}/g) || []) {
        sse(res, {
          id,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning: piece }, finish_reason: null }],
        });
        await new Promise((r) => setTimeout(r, 12));
        if (res.destroyed) return;
      }

      // 按 2-6 个字符切块，模拟真实模型的 token 粒度
      const pieces = full.match(/[\s\S]{1,5}/g) || [];

      for (const piece of pieces) {
        sse(res, {
          id,
          object: 'chat.completion.chunk',
          model: payload.model || 'mock-model',
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        });
        await new Promise((r) => setTimeout(r, CHUNK_DELAY));
        if (res.destroyed) return;
      }

      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, () => {
  console.log(`mock OpenAI 服务已启动：http://localhost:${PORT}/v1`);
  console.log('在扩展设置页把 Base URL 填这个地址，模型名随便填，就能离线测试。');
});
