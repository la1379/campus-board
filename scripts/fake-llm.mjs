/**
 * 假模型服务器：本地起一个 OpenAI 兼容端点，顶掉 DeepSeek。
 *
 * 用途有两个：
 *   1. scripts/test-intake.mjs 自动测试时内置一份（不需单独启动）
 *   2. 手动在浏览器里点录入器时，可以单独启这个，再用
 *      DEEPSEEK_BASE_URL=http://127.0.0.1:7791 npm start 指向它
 *
 * 它返回什么样的 JSON，取决于请求里的【公告文字】第一个词：
 *   happy / fenced / notjob / baddate / chanfix / chanlie / nochan / scalar
 * 不认识的词一律返回 happy 剧本。
 *
 * 用法：node scripts/fake-llm.mjs [--port 7791]
 */
import http from 'node:http';

const PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 7791);

const SCRIPTS = {
  happy: JSON.stringify({
    company: '【测试】示例制造股份有限公司',
    title: '2027届校园招聘',
    batch: '27届秋招',
    positions: ['采购专员', '供应计划工程师'],
    majors: ['工业工程', '物流管理'],
    work_content: '负责物料采购与交期跟催',
    cities: ['杭州', '嘉兴'],
    deadline: '2026-12-15',
    deadline_raw: '12月15日截止',
    channel_type: 'email',
    channel_email: 'hr@test-mfg.com',
    channel_url: '',
    channel_steps: '投递至 hr@test-mfg.com，标题「姓名+学校+岗位」',
    industry: '制造业',
    note: '本科可投，需 CET4，有笔试',
    url: 'https://test-mfg.com/campus',
  }),
  fenced: '```json\n' + JSON.stringify({
    company: '【测试】围栏公司',
    title: '2027届招聘', batch: '27届秋招',
    positions: ['采购专员'], majors: ['工业工程'], cities: ['杭州'],
    deadline: null, channel_type: 'wechat',
    channel_steps: '关注公众号「围栏招聘」→ 校园招聘',
  }) + '\n```',
  notjob: JSON.stringify({ error: 'not_a_job_posting' }),
  baddate: JSON.stringify({
    company: '【测试】坏日期公司', title: '招聘',
    positions: ['采购'], majors: [], cities: ['杭州'],
    deadline: '10月30日', deadline_raw: '10月30日截止',
    channel_type: 'link', channel_url: 'https://example.com/apply',
  }),
  chanfix: JSON.stringify({
    company: '【测试】渠道纠正公司', title: '招聘',
    positions: ['采购专员'], majors: ['工业工程'], cities: ['杭州'],
    deadline: null, channel_type: 'wechat',
    channel_email: 'jobs@chanfix.com', channel_steps: '关注公众号',
  }),
  chanlie: JSON.stringify({
    company: '【测试】空邮箱公司', title: '招聘',
    positions: ['采购'], majors: [], cities: ['杭州'],
    deadline: null, channel_type: 'email', channel_email: '',
  }),
  nochan: JSON.stringify({
    company: '【测试】无渠道公司', title: '招聘',
    positions: ['采购'], majors: [], cities: ['杭州'],
    deadline: null, channel_type: 'unknown',
  }),
  scalar: JSON.stringify({
    company: '【测试】标量公司', title: '招聘',
    positions: '采购专员', majors: '工业工程', cities: '杭州',
    deadline: null, channel_type: 'site', channel_url: 'https://scalar.com',
  }),
};

function pick(prompt) {
  const m = /【公告文字】\s*(\S+)/.exec(prompt);
  return SCRIPTS[m ? m[1] : ''] || SCRIPTS.happy;
}

const srv = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let prompt = '';
  try {
    const j = JSON.parse(body);
    const c = j.messages?.[0]?.content;
    prompt = typeof c === 'string' ? c : (c || []).map(x => x.text || '').join(' ');
  } catch { /* ignore */ }

  const out = JSON.stringify({
    choices: [{ message: { content: pick(prompt) } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(out),
  });
  res.end(out);
});

srv.listen(PORT, '127.0.0.1', () => {
  console.log('假模型服务已启动: http://127.0.0.1:' + PORT);
  console.log('剧本: ' + Object.keys(SCRIPTS).join(' / '));
  console.log('');
  console.log('配合使用:');
  console.log('  DEEPSEEK_API_KEY=sk-fake DEEPSEEK_BASE_URL=http://127.0.0.1:' +
    PORT + ' node server.mjs --port 7794');
});
