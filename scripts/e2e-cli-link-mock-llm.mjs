// Iris Link 端到端用的本地假模型（OpenAI 兼容流式接口，带 CORS）。只给 mock 内容，不转发、不发任何真实付费请求。
// 剧本按用户消息里的 [e2e:*] 标记选择，并按本轮已有的工具结果数逐步推进（与 tools/iris/link/agent-commands.js 的 E2E_SCENARIOS 对应）。
// 用法：node scripts/e2e-cli-link-mock-llm.mjs [port=5299] [chunkDelayMs=40]
import http from 'node:http';

const port = Number(process.argv[2] || 5299);
const delay = Number(process.argv[3] || 40);
const log = [];

const PLANS = {
  answer: [{ reasoning: '用户只要一句话介绍，不需要工具。', text: 'Iris 是一个本地优先的 AI 创作画布：素材、生成和 Agent 都在同一张画布上。' }],
  tool: [
    { reasoning: '先看一下画布上有哪些节点。', tool: { name: 'iris_workflow_inspect', args: { summary: true } } },
    { text: '画布上有「主角定妆」图片和「色调备注」文本两个节点。' },
  ],
  'tool-error': [
    { reasoning: '定位用户说的那个节点。', tool: { name: 'iris_workflow_focus_nodes', args: { nodeIds: ['e2e-missing-node'] } } },
    { text: '节点 e2e-missing-node 不在画布上，定位失败。' },
  ],
  approval: [
    { reasoning: '写一条备注到画布上，这会修改画布，需要确认。', tool: { name: 'iris_note_write', args: { title: 'e2e', text: 'e2e 审批测试' } } },
    { text: '备注「e2e 审批测试」已经写到画布上。' },
  ],
  paid: [
    { reasoning: '用户要重新生成主角定妆，这是付费生成。', tool: { name: 'iris_workflow_node_run', args: { nodeId: 'img-hero' } } },
    { text: '生成没有被批准，节点保持原样。' },
  ],
  'parallel-a': [{ reasoning: '慢慢想：这是 A 会话，先把思路理清楚再回答，不需要任何工具。', text: 'A', slow: 3 }],
  'parallel-b': [{ reasoning: '慢慢想：这是 B 会话，和 A 同时在跑，同样不需要工具。', text: 'B', slow: 3 }],
  cancel: [{ reasoning: '先把整段节奏拆开：开场、建立、冲突、转折、收尾。每一段都要对照项目记忆里的色调和时长要求，逐个镜头估算秒数，再看哪些镜头可以合并，哪些需要补拍。这一步会非常久，一帧一帧地过，一直想下去，直到被停止为止。', text: '（这一轮应该已经被取消）', slow: 12 }],
  canvas: [
    { reasoning: '在画布会话卡里回答：先看看画布。', tool: { name: 'iris_workflow_inspect', args: { summary: true } } },
    { text: '画布上有两个节点；这轮回答也落在了会话卡上。' },
  ],
};

function realUserIndex(messages) {
  let last = -1;
  messages.forEach((message, index) => {
    // 工具结果里的图片会以 user 消息追加；只把不紧跟 tool 的 user 当作这一轮的起点。
    if (message.role === 'user' && messages[index - 1]?.role !== 'tool') last = index;
  });
  return last;
}

function textOf(message) {
  return typeof message?.content === 'string' ? message.content : (message?.content || []).map(part => part.text || '').join('');
}

function planFor(body) {
  const messages = body.messages || [];
  const start = realUserIndex(messages);
  const marker = /\[e2e:([\w-]+)\]/.exec(textOf(messages[start]))?.[1];
  const plan = PLANS[marker] || [{ text: '好的。（mock 回复）' }];
  const toolResults = messages.slice(start + 1).filter(message => message.role === 'tool').length;
  return { marker: marker || 'none', step: plan[Math.min(toolResults, plan.length - 1)] };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-chat', object: 'model', context_length: 128000 }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const { marker, step } = planFor(body);
    log.push({ at: new Date().toISOString(), marker, stream: Boolean(body.stream), messages: (body.messages || []).length, tools: (body.tools || []).length, step: step.tool?.name || 'text' });
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'e2e 会话' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = obj => { if (!res.destroyed) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const chunk = delta => send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta }] });
    chunk({ role: 'assistant', content: '' });
    let out = 0;
    if (step.reasoning) {
      const chars = [...step.reasoning];
      for (let i = 0; i < chars.length; i += 2) { await sleep(delay * (step.slow || 1)); if (res.destroyed) return; chunk({ reasoning_content: chars.slice(i, i + 2).join('') }); }
      out += chars.length;
    }
    if (step.tool) {
      await sleep(delay * 2);
      const id = 'call_' + step.tool.name + '_' + (body.messages || []).length;
      chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: step.tool.name, arguments: '' } }] });
      const args = JSON.stringify(step.tool.args);
      for (let i = 0; i < args.length; i += 24) { await sleep(10); chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 24) } }] }); }
      send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: out + 20, total_tokens: 140 + out } });
    } else {
      const chars = [...(step.text || '')];
      for (let i = 0; i < chars.length; i += 3) { await sleep(delay); if (res.destroyed) return; chunk({ content: chars.slice(i, i + 3).join('') }); }
      send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: out + chars.length, total_tokens: 120 + out + chars.length } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(port, '127.0.0.1', () => console.log('iris-link mock llm on ' + port));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
