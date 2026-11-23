#!/usr/bin/env node
// 手动探测：DeepSeek 服务端扩展（title / deepseek_web_search / safety_check）能否与 function 工具同时声明。
// 用法：
//   DEEPSEEK_API_KEY=sk-... node scripts/probe-deepseek-ext.mjs
//   可选：DEEPSEEK_MODEL（默认 deepseek-flash）、DEEPSEEK_BASE_URL（默认 https://api.deepseek.com）、PROBE_JSON=1 打印原始响应
// 每个用例发一次非流式 /chat/completions；title 额外发一次流式请求看 delta.title。会产生少量计费（联网搜索按次计费）。
// 结论对应 services/deepseekExtensions.ts 的兼容记忆：coexist → 不降级；exclusive → 扩展与 function 工具二选一；unsupported → 模型不认字段。

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY');
  process.exit(2);
}
const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const showJson = process.env.PROBE_JSON === '1';

const functionTool = {
  type: 'function',
  function: {
    name: 'get_canvas_node',
    description: 'Read a node on the Iris canvas by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

const cases = [
  { name: 'baseline: function tool only', body: { tools: [functionTool] }, question: '你好，用一句话介绍你自己。' },
  { name: 'title only (no function tool)', body: { title: { enabled: true } }, question: '明天北京会下雨吗？' },
  { name: 'title + function tool', body: { title: { enabled: true }, tools: [functionTool] }, question: '明天北京会下雨吗？' },
  { name: 'deepseek_web_search + function tool', body: { tools: [functionTool, { type: 'deepseek_web_search' }] }, question: 'DeepSeek 最近发布了什么？请联网查一下。' },
  { name: 'safety_check + function tool', body: { safety_check: { level: 'high' }, tools: [functionTool] }, question: '你好' },
  { name: 'all three + function tool', body: { title: { enabled: true }, safety_check: { level: 'high' }, tools: [functionTool, { type: 'deepseek_web_search' }] }, question: '今天上海天气怎么样？' },
];

function classify(status, text) {
  if (status === 200) return 'coexist';
  if (/other tools cannot be used together with/i.test(text)) return 'exclusive';
  if (/deepseek_web_search|safety_check|title/i.test(text) && /unknown|unrecognized|unsupported|not support|not allowed|extra/i.test(text)) return 'unsupported';
  return 'other-error';
}

async function post(body, stream = false) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 512, stream, ...body }),
  });
  const text = await response.text();
  return { status: response.status, text, ms: Date.now() - started };
}

function summarize(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  return {
    finish_reason: choice.finish_reason,
    title: message.title,
    content: typeof message.content === 'string' ? message.content.slice(0, 80) : message.content,
    tool_calls: (message.tool_calls || []).map(call => call.function?.name),
    server_tool_calls_steps: Array.isArray(message.server_tool_calls) ? message.server_tool_calls.length : undefined,
    annotations: Array.isArray(message.annotations) ? message.annotations.length : undefined,
    refusal: message.refusal,
    safety_tokens: json?.usage?.completion_tokens_details?.safety_tokens,
  };
}

const results = [];
console.log(`DeepSeek 扩展探测：${baseUrl}  model=${model}\n`);
for (const testCase of cases) {
  const body = { ...testCase.body, messages: [{ role: 'user', content: testCase.question }] };
  try {
    const { status, text, ms } = await post(body);
    const verdict = classify(status, text);
    results.push({ case: testCase.name, status, verdict });
    console.log(`■ ${testCase.name}`);
    console.log(`  HTTP ${status}  ${ms}ms  → ${verdict}`);
    if (status === 200) {
      let json;
      try { json = JSON.parse(text.trim()); } catch { json = null; }
      console.log('  ', JSON.stringify(json ? summarize(json) : text.slice(0, 200)));
      if (showJson) console.log(text);
    } else {
      console.log('  ', text.slice(0, 400));
    }
  } catch (error) {
    results.push({ case: testCase.name, status: 'network', verdict: 'network-error' });
    console.log(`■ ${testCase.name}\n  网络错误：${error instanceof Error ? error.message : error}`);
  }
  console.log('');
}

// 流式：title 在最后一个 chunk 的 delta.title（与 function 工具同时声明）
try {
  const { status, text, ms } = await post({ title: { enabled: true }, tools: [functionTool], messages: [{ role: 'user', content: '给我讲个笑话' }] }, true);
  console.log('■ stream: title + function tool');
  console.log(`  HTTP ${status}  ${ms}ms  → ${classify(status, text)}`);
  if (status === 200) {
    let title;
    let finish;
    for (const line of text.split('\n')) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        if (choice?.delta?.title) title = choice.delta.title;
        if (choice?.finish_reason) finish = choice.finish_reason;
      } catch { /* keep-alive 等 */ }
    }
    console.log(`   delta.title=${JSON.stringify(title)} finish_reason=${finish}`);
  } else {
    console.log('  ', text.slice(0, 400));
  }
} catch (error) {
  console.log(`■ stream: title + function tool\n  网络错误：${error instanceof Error ? error.message : error}`);
}

console.log('\n汇总：');
console.table(results);
