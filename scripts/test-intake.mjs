/**
 * 录入器端到端测试：用「假模型服务器」顶掉 DeepSeek，跑真实代码路径。
 *
 * 为什么不能只用 `node server.mjs --mock` 测：
 *   --mock 在 callLLM() 的第 0 行就 return 了，**根本不发 HTTP、不解析模型输出、
 *   不经过 normalize() 的清洗逻辑**。而录入器真正会出错的地方恰好全在 normalize()：
 *     · 模型把 JSON 包在 ```json 里
 *     · 模型把 deadline 写成"10月30日"
 *     · 模型说有邮箱但 channel_type 填了 wechat
 *     · 模型返回 {"error":"not_a_job_posting"}
 *   这些分支用 mock 一个都测不到。所以这里造一个假的 OpenAI 兼容端点，
 *   让真实 server.mjs 发出真实请求，再断言它把脏输出洗对了。
 *
 * 用法：node scripts/test-intake.mjs
 * 退出码 0 = 全绿
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FAKE_PORT = 7791;
const BOARD_PORT = 7792;
const BOARD = `http://127.0.0.1:${BOARD_PORT}`;

const fails = [];
const checks = [];

function check(name, cond, detail = '') {
  checks.push([name, !!cond, detail]);
  if (!cond) fails.push(name);
}

// ---------- 假模型：按请求里的关键字返回不同剧本 ----------

const SCRIPTS = {
  // 正常公告
  happy: JSON.stringify({
    company: '测试制造股份有限公司',
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
    channel_steps: '投递至 hr@test-mfg.com',
    industry: '制造业',
    note: '本科可投，有笔试',
    url: 'https://test-mfg.com/campus',
  }),

  // 模型把 JSON 包进 ```json 围栏（真实高频）
  fenced: '```json\n' + JSON.stringify({
    company: '围栏公司',
    title: '2027届招聘',
    batch: '27届秋招',
    positions: ['采购专员'],
    majors: ['工业工程'],
    cities: ['杭州'],
    deadline: null,
    channel_type: 'wechat',
    channel_steps: '关注公众号「围栏招聘」→ 校园招聘',
  }) + '\n```',

  // 不是招聘公告
  notjob: JSON.stringify({ error: 'not_a_job_posting' }),

  // 截止日写成中文 → 应判为不合法，置 null 并给警告
  baddate: JSON.stringify({
    company: '坏日期公司',
    title: '招聘',
    positions: ['采购'],
    majors: [],
    cities: ['杭州'],
    deadline: '10月30日',
    deadline_raw: '10月30日截止',
    channel_type: 'link',
    channel_url: 'https://example.com/apply',
  }),

  // 有邮箱但类型写了 wechat → 应自动纠正为 email
  chanfix: JSON.stringify({
    company: '渠道纠正公司',
    title: '招聘',
    positions: ['采购专员'],
    majors: ['工业工程'],
    cities: ['杭州'],
    deadline: null,
    channel_type: 'wechat',
    channel_email: 'jobs@chanfix.com',
    channel_steps: '关注公众号',
  }),

  // 说 email 但其实没抽到地址 → 应给警告
  chanlie: JSON.stringify({
    company: '空邮箱公司',
    title: '招聘',
    positions: ['采购'],
    majors: [],
    cities: ['杭州'],
    deadline: null,
    channel_type: 'email',
    channel_email: '',
  }),

  // 完全没渠道 → 应给「请人工补」
  nochan: JSON.stringify({
    company: '无渠道公司',
    title: '招聘',
    positions: ['采购'],
    majors: [],
    cities: ['杭州'],
    deadline: null,
    channel_type: 'unknown',
  }),

  // 模型返回字符串而不是数组 → arr() 应包成单元素数组
  scalar: JSON.stringify({
    company: '标量公司',
    title: '招聘',
    positions: '采购专员',
    majors: '工业工程',
    cities: '杭州',
    deadline: null,
    channel_type: 'site',
    channel_url: 'https://scalar.com',
  }),
};

function pickScript(prompt) {
  const m = /【公告文字】\s*(\S+)/.exec(prompt);
  const key = m ? m[1] : '';
  return SCRIPTS[key] || SCRIPTS.happy;
}

function startFakeLLM() {
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      let prompt = '';
      try {
        const j = JSON.parse(body);
        const c = j.messages?.[0]?.content;
        prompt = typeof c === 'string' ? c : (c || []).map(x => x.text || '').join(' ');
      } catch { /* ignore */ }

      const content = pickScript(prompt);
      const out = JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(out),
      });
      res.end(out);
    });
    srv.listen(FAKE_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- 启动被测服务 ----------

function startBoard() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs', '--port', String(BOARD_PORT)], {
      cwd: ROOT,
      env: {
        ...process.env,
        // 用 LLM_*（server.mjs 现在的通用变量名）。
        // 早先这里是 DEEPSEEK_*，改名后测试会静默连上真实的 .env.local 端点 ——
        // 表现是「假模型剧本全部返回 not_a_job_posting」，因为真模型看到
        // `happy 测试` 这种无意义文本确实会判非公告。
        LLM_API_KEY: 'sk-fake-for-test',
        LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
        LLM_MODEL: 'fake-model',
        // 显式清掉旧的，避免任何兜底路径捡到真 key
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        DEEPSEEK_MODEL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    // 轮询 health，别靠固定 sleep
    const t0 = Date.now();
    const tick = async () => {
      if (Date.now() - t0 > 10000) return reject(new Error('服务启动超时: ' + err));
      try {
        const r = await fetch(BOARD + '/api/health');
        const h = await r.json();
        if (h.ok) return resolve({ child, health: h });
      } catch { /* 还没起来 */ }
      setTimeout(tick, 150);
    };
    tick();
  });
}

// ---------- 请求 ----------

async function extract(text, extra = {}) {
  const r = await fetch(BOARD + '/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

async function postBatch(records) {
  const r = await fetch(BOARD + '/api/jobs/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  return { status: r.status, body: await r.json() };
}

async function postJob(obj) {
  const r = await fetch(BOARD + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  return { status: r.status, body: await r.json() };
}

// ---------- 主流程 ----------

async function main() {
  const fake = await startFakeLLM();
  const { child, health } = await startBoard();
  const createdIds = [];

  try {
    check('服务识别到已配置模型', health.llm === 'configured',
      `llm=${health.llm}`);

    // --- 1. 正常公告 ---
    {
      const { status, body } = await extract('happy');
      check('正常公告 HTTP 200', status === 200, `status=${status}`);
      const r = body.record || {};
      check('公司名抽取正确', r.company === '测试制造股份有限公司', r.company);
      check('岗位数组抽取正确',
        Array.isArray(r.positions) && r.positions.length === 2, JSON.stringify(r.positions));
      check('专业数组抽取正确',
        Array.isArray(r.majors) && r.majors.includes('工业工程'), JSON.stringify(r.majors));
      check('截止日格式正确', r.deadline === '2026-12-15', String(r.deadline));
      check('邮箱抽取正确', r.channel_email === 'hr@test-mfg.com', r.channel_email);
      check('来源字段透传到 record', r.source === '' || typeof r.source === 'string');
      check('正常公告无置信度警告',
        Object.keys(body.confidence || {}).length === 0,
        JSON.stringify(body.confidence));
    }

    // --- 2. ```json 围栏 ---
    {
      const { body } = await extract('fenced');
      check('markdown 围栏能被剥掉',
        body.ok && body.record.company === '围栏公司',
        body.ok ? body.record.company : body.error);
      check('围栏内的 null 截止日保持 null',
        body.record && body.record.deadline === null, String(body.record?.deadline));
      check('公众号渠道被识别',
        body.record && body.record.channel_type === 'wechat',
        String(body.record?.channel_type));
    }

    // --- 3. 不是招聘公告 ---
    {
      const { status, body } = await extract('notjob');
      check('非公告返回 422', status === 422, `status=${status}`);
      check('非公告 ok=false', body.ok === false);
      check('非公告错误码正确', body.error === 'not_a_job_posting', String(body.error));
    }

    // --- 4. 截止日写成中文 ---
    {
      const { body } = await extract('baddate');
      check('非法日期被置 null', body.record.deadline === null,
        String(body.record.deadline));
      check('非法日期给置信度警告',
        /格式不合法/.test(body.confidence.deadline || ''),
        JSON.stringify(body.confidence));
      check('非法日期保留原文',
        body.record.deadline_raw === '10月30日截止', body.record.deadline_raw);
    }

    // --- 5. 有邮箱但类型写错 ---
    {
      const { body } = await extract('chanfix');
      check('邮箱存在时自动纠正为 email',
        body.record.channel_type === 'email', body.record.channel_type);
      check('渠道纠正有提示',
        /修正为 email/.test(body.confidence.channel || ''),
        JSON.stringify(body.confidence));
    }

    // --- 6. 声称 email 但没地址 ---
    {
      const { body } = await extract('chanlie');
      check('空邮箱给警告',
        /没抽到邮箱地址/.test(body.confidence.channel || ''),
        JSON.stringify(body.confidence));
      check('空邮箱时 channel_email 为空串',
        body.record.channel_email === '', JSON.stringify(body.record.channel_email));
    }

    // --- 6b. 两条警告同时成立时不能被互相覆盖 ---
    {
      const { body } = await extract('chanlie');
      const w = body.confidence.channel || '';
      check('空邮箱同时报「没地址」和「没渠道」',
        w.includes('没抽到邮箱地址') && w.includes('请人工补'), w);
    }

    // --- 7. 完全没渠道 ---
    {
      const { body } = await extract('nochan');
      check('无渠道提示人工补',
        /请人工补/.test(body.confidence.channel || ''),
        JSON.stringify(body.confidence));
    }

    // --- 8. 标量代替数组 ---
    {
      const { body } = await extract('scalar');
      check('标量岗位名包成数组',
        Array.isArray(body.record.positions) && body.record.positions[0] === '采购专员',
        JSON.stringify(body.record.positions));
      check('标量专业包成数组',
        Array.isArray(body.record.majors) && body.record.majors[0] === '工业工程',
        JSON.stringify(body.record.majors));
    }

    // --- 9. 空输入被拒 ---
    {
      const { status, body } = await extract('');
      check('空文本返回 400', status === 400, `status=${status}`);
      check('空文本有错误信息', !!body.error, String(body.error));
    }

    // --- 10. 落库：抽取结果 → jobs.json ---
    {
      const { body: ex } = await extract('happy');
      const rec = ex.record;
      const { status, body } = await postJob({ record: rec });
      check('保存 HTTP 200', status === 200, `status=${status}`);
      check('保存返回 id', !!body.id, String(body.id));
      if (body.id) createdIds.push(body.id);

      const all = await (await fetch(BOARD + '/api/jobs')).json();
      const saved = (all.jobs || []).find(j => j.id === body.id);
      check('落库后能读回', !!saved, '未找到 ' + body.id);
      if (saved) {
        check('落库保留邮箱', saved.channel_email === 'hr@test-mfg.com', saved.channel_email);
        check('落库 deadline_kind=date', saved.deadline_kind === 'date', saved.deadline_kind);
        check('落库新记录 starred=false', saved.starred === false);
        check('落库排在最前', all.jobs[0].id === body.id,
          `first=${all.jobs[0].id} saved=${body.id}`);
      }
    }

    // --- 11. 删除清理 ---
    {
      const id = createdIds[0];
      if (id) {
        const r = await fetch(BOARD + '/api/jobs/' + id, { method: 'DELETE' });
        const d = await r.json();
        check('删除返回 ok', d.ok === true, JSON.stringify(d));
        const all = await (await fetch(BOARD + '/api/jobs')).json();
        check('删除后确实没了', !(all.jobs || []).some(j => j.id === id));
        createdIds.length = 0;
      }
    }

    // --- 12. 清单模式：规则解析（不调模型）---
    {
      const text = [
        'base 杭州篇',
        '国信证券  base杭州  招满即止',
        '国药集团  base杭州  12月31日截止',
        '中铝集团  base杭州  27年3月7日截止',
      ].join('\n');
      const { status, body } = await extract(text, { mode: 'list', source: '测试清单' });
      check('清单模式 HTTP 200', status === 200, `status=${status}`);
      check('清单走规则解析（未调模型）', body.from === 'rule', String(body.from));
      check('清单解析出 3 条', (body.items || []).length === 3,
        String((body.items || []).length));

      const byCo = {};
      (body.items || []).forEach(x => { byCo[x.company] = x; });
      check('清单: 招满即止 → deadline=null + kind=rolling',
        byCo['国信证券'] && byCo['国信证券'].deadline === null &&
        byCo['国信证券'].deadline_kind === 'rolling',
        JSON.stringify(byCo['国信证券']));
      check('清单: 12月31日 → 当年 12-31',
        byCo['国药集团'] && byCo['国药集团'].deadline === '2026-12-31',
        byCo['国药集团'] && byCo['国药集团'].deadline);
      check('清单: 27年3月7日 → 2027-03-07',
        byCo['中铝集团'] && byCo['中铝集团'].deadline === '2027-03-07',
        byCo['中铝集团'] && byCo['中铝集团'].deadline);
      check('清单: 城市都解析为杭州',
        (body.items || []).every(x => (x.cities || []).indexOf('杭州') >= 0),
        JSON.stringify((body.items || []).map(x => x.cities)));
      check('清单: 公司名没有残留 base/截止片段',
        (body.items || []).every(x =>
          !/base|截止|招满/.test(x.company)),
        JSON.stringify((body.items || []).map(x => x.company)));

      // 批量落库
      const before = (await (await fetch(BOARD + '/api/jobs')).json()).jobs.length;
      const b = await postBatch(body.items);
      check('批量保存 HTTP 200', b.status === 200, `status=${b.status}`);
      check('批量保存 3 条', b.body.saved === 3, String(b.body.saved));
      const after = (await (await fetch(BOARD + '/api/jobs')).json());
      check('批量保存后总数 +3', after.jobs.length === before + 3,
        `${before} -> ${after.jobs.length}`);
      (b.body.ids || []).forEach(id => createdIds.push(id));
      const saved = after.jobs.find(j => j.id === (b.body.ids || [])[0]);
      check('批量落库保留了源', saved && saved.source === '测试清单',
        saved && saved.source);
    }

    // --- 13. 批量保存的空值/非法输入 ---
    {
      const { status } = await postBatch([]);
      check('空数组保存返回 400', status === 400, `status=${status}`);

      const big = Array.from({ length: 201 }, (_, i) => ({ company: 'X' + i }));
      const { status: s2, body: b2 } = await postBatch(big);
      check('超过 200 条被拒', s2 === 400, `status=${s2} ${b2.error || ''}`);

      // 无公司名的应被跳过，不中断整批
      const before = (await (await fetch(BOARD + '/api/jobs')).json()).jobs.length;
      const { body: b3 } = await postBatch([
        { company: '有效公司A', cities: ['杭州'] },
        { company: '', title: '没公司名' },
      ]);
      check('无公司名的条目被跳过', b3.saved === 1 && b3.skipped.length === 1,
        JSON.stringify({ saved: b3.saved, skipped: b3.skipped }));
      (b3.ids || []).forEach(id => createdIds.push(id));
      const after = (await (await fetch(BOARD + '/api/jobs')).json()).jobs.length;
      check('跳过后只新增 1 条', after === before + 1, `${before} -> ${after}`);
    }
  } finally {
    // 清理顺序很重要：先把落库的测试记录删掉，再停服务。
    // 踩过的坑：原来 child.kill() 在前，服务一停就删不了了，
    // 测试记录会永久留在 jobs.json 里。
    for (const id of createdIds) {
      try {
        await fetch(BOARD + '/api/jobs/' + id, { method: 'DELETE' });
      } catch { /* 服务已停 */ }
    }
    child.kill();
    fake.close();
  }

  return report();
}

function report() {
  console.log('');
  for (const [name, ok, detail] of checks) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
      ((!ok && detail) ? '  <- ' + detail : ''));
  }
  console.log('');
  if (fails.length) {
    console.log(`RESULT: FAIL (${fails.length}/${checks.length})`);
    return 1;
  }
  console.log(`RESULT: PASS (${checks.length}/${checks.length})`);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('X 测试异常:', e.message);
    process.exit(2);
  });
