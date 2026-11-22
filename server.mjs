/**
 * 本地服务：看板 + 录入器 API。零 npm 依赖，只用 Node 内置模块。
 *
 *   npm start          → http://127.0.0.1:7788
 *   npm start -- --port 3000
 *
 * 路由：
 *   GET  /                    看板
 *   GET  /data/jobs.json      数据
 *   POST /api/extract         粘贴文案/长图 → 结构化记录（不落库）
 *   POST /api/jobs            确认后落库
 *   DELETE /api/jobs/:id      删除
 *   GET  /api/health          健康检查
 *
 * 环境变量（.env.local）：
 *   DEEPSEEK_API_KEY=sk-xxx
 *   DEEPSEEK_BASE_URL=https://api.deepseek.com   （默认）
 *   DEEPSEEK_MODEL=deepseek-chat                  （默认）
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : process.env.PORT || 7788);

// ---------- 环境变量 ----------

function loadEnv() {
  const p = path.join(__dirname, '.env.local');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const ENV = { ...loadEnv(), ...process.env };

// 通用 LLM 配置：任何 OpenAI 兼容端点都能用（DeepSeek / 阿里云百炼 / 智谱 / 本地 vLLM…）。
// 保留 DEEPSEEK_* 作兜底，因为之前的 .env.local 是那么写的，不能一改就废。
const LLM_KEY = ENV.LLM_API_KEY || ENV.DEEPSEEK_API_KEY || '';
const LLM_BASE = (ENV.LLM_BASE_URL || ENV.DEEPSEEK_BASE_URL ||
  'https://api.deepseek.com').replace(/\/$/, '');
const LLM_MODEL = ENV.LLM_MODEL || ENV.DEEPSEEK_MODEL || 'deepseek-chat';

// 看图要单独的模型：百炼上文本模型(qwen-plus)吃不了图片，得用 qwen-vl-*。
// 没配就跟文本模型共用一个 —— DeepSeek 官方本来也不支持图片，行为和以前一致。
const LLM_VISION_MODEL = ENV.LLM_VISION_MODEL || ENV.DEEPSEEK_VISION_MODEL || '';

// --mock：不调真模型，返回固定样本。用来先验证整条管道通不通。
const MOCK = process.argv.includes('--mock');

// ---------- 常量 ----------

const DATA_FILE = path.join(__dirname, 'data', 'jobs.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ---------- 数据读写 ----------

async function readData() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { version: 2, updated: new Date().toISOString().slice(0, 10), jobs: [] };
    }
    throw e;
  }
}

// 写盘用「临时文件 + rename」：写到一半断电不会留下半个 JSON。
let writeChain = Promise.resolve();
function writeData(data) {
  writeChain = writeChain.then(async () => {
    data.updated = new Date().toISOString().slice(0, 10);
    const tmp = DATA_FILE + '.tmp';
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
  });
  return writeChain;
}

// ---------- HTTP 小工具 ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 24 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
}

// ---------- 静态文件 ----------

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越：解析后必须仍在项目根内
  const abs = path.resolve(__dirname, '.' + rel);
  if (!abs.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const buf = await fs.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---------- 规则解析：规整清单不调模型 ----------

/**
 * 从「公司名 base城市 截止」这种一行一家的清单里直接解析，不调模型。
 *
 * 为什么要这条路径：
 *   xhs 盘点文（如「base 杭州篇」）格式高度规整，30 家一行一条。
 *   用模型抽既慢（~5s）又花 token，还可能把公司名读歪。
 *   规则解析零 token、毫秒级、结果确定。
 *
 * 模型只在「格式乱了」时才上 —— 判断标准是：规则能解析出 ≥3 行就认为格式规整。
 * 返回 null 表示「这格式我认不了，交给模型」。
 */
function parseListLines(text) {
  const lines = String(text || '').split(/\r?\n/);

  // 城市词表：清单里的「base杭州」要能认出来。只收常见校招城市，漏了不致命。
  // 用字符串拼再构造 RegExp —— 正则字面量不能跨行。
  const CITY_LIST = [
    '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '苏州', '宁波',
    '无锡', '常州', '嘉兴', '湖州', '绍兴', '金华', '台州', '温州', '合肥', '武汉',
    '长沙', '成都', '西安', '郑州', '济南', '青岛', '沈阳', '大连', '哈尔滨', '长春',
    '福州', '厦门', '南昌', '昆明', '贵阳', '南宁', '兰州', '太原', '石家庄', '乌鲁木齐',
    '呼和浩特', '银川', '西宁', '拉萨', '海口', '珠海', '佛山', '东莞', '中山', '惠州',
  ];
  const CITY = new RegExp('^(' + CITY_LIST.join('|') + ')$');

  // 截止日：招满即止 / 12月31日截止 / 27年3月7日截止 / 长期
  function parseDeadline(s) {
    if (/招满即止|滚动招聘|长期有效|长期/.test(s)) {
      return { deadline: null, kind: 'rolling', raw: '招满即止' };
    }
    let m = s.match(/(20\d{2}|\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      const y = m[1].length === 2 ? '20' + m[1] : m[1];
      const iso = mkISO(y, m[2], m[3]);
      if (iso) return { deadline: iso, kind: 'date', raw: m[0] + '截止' };
    }
    m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      const iso = mkISO(String(new Date().getFullYear()), m[1], m[2]);
      if (iso) return { deadline: iso, kind: 'date', raw: m[0] + '截止' };
    }
    return { deadline: null, kind: 'unknown', raw: '' };
  }

  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过标题行、分隔行
    if (/^(base|#|\|)|篇$|清单$|合集$|汇总$/.test(line)) continue;
    // 至少要有「公司 + 城市」或「公司 + 截止」两类信息之一，才当一条
    if (line.length < 4) continue;

    // 切掉开头的序号、项目符号、星级
    let s = line.replace(/^[\s★☆·•\-–—*\d.、)）]+/, '').trim();
    if (!s) continue;

    // 找城市："base杭州" / "（杭州）" / "杭州"
    let city = '';
    const mBase = s.match(/base\s*([一-龥]{2,4})/i);
    if (mBase && CITY.test(mBase[1])) city = mBase[1];
    if (!city) {
      for (const tok of s.match(/[一-龥]{2,4}/g) || []) {
        if (CITY.test(tok)) { city = tok; break; }
      }
    }

    const dl = parseDeadline(s);

    // 公司名：去掉城市片段、截止片段、中间的分隔符
    let company = s
      .replace(/base\s*[一-龥]{2,4}/gi, ' ')
      .replace(/(20\d{2}|\d{2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(截|前)?止?/g, ' ')
      .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日(截|前)?止?/g, ' ')
      .replace(/招满即止|滚动招聘|长期有效|长期/g, ' ')
      .replace(/[|｜,，、;；:：\t]+/g, ' ')
      .replace(/base/gi, ' ')
      .trim();
    // 去掉尾部残留的单个城市名
    company = company.replace(new RegExp('(^|\\s)' + (city || '') + '$'), '').trim();
    if (!company || company.length < 2) continue;

    // 至少命中城市或截止之一才算真记录，否则可能是正文段落
    if (!city && !dl.deadline && dl.kind === 'unknown') continue;

    out.push({
      company: company.slice(0, 40),
      title: '',
      batch: '',
      positions: [],
      majors: [],
      work_content: '',
      cities: city ? [city] : [],
      deadline: dl.deadline,
      deadline_kind: dl.kind,
      deadline_raw: dl.raw,
      channel_type: 'unknown',
      channel_email: '',
      channel_url: '',
      channel_steps: '',
      industry: '',
      note: '',
      url: '',
    });
  }

  // 少于 3 条说明这格式不是规整清单，交给模型
  return out.length >= 3 ? out : null;
}

function mkISO(y, mo, d) {
  const yy = Number(y), mm = Number(mo), dd = Number(d);
  if (!yy || !mm || !dd || mm > 12 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return dt.toISOString().slice(0, 10);
}


const SCHEMA_HINT = `{
  "company":   "公司名称（保留括号里的系属备注，如'菜鸟网络（阿里系）'；去掉★）",
  "title":     "招聘简章标题，尽量保留原文",
  "batch":     "批次，如 '27届秋招' / '26届春招'，从届数判断；判断不出填 ''",
  "positions": ["在招岗位名，逐个列出，如 ['采购专员','供应计划工程师']；只写原文有的"],
  "majors":    ["专业要求，如 ['工业工程','物流管理','机械']；写了'专业不限'就填 ['不限']；原文没写填 []"],
  "work_content": "这个岗位主要做什么，20字内一句话概括，如 '负责物料采购与交期跟催'；说不清填 ''",
  "cities":    ["工作城市，只填城市名，如 '杭州'"],
  "deadline":  "网申截止日，严格 YYYY-MM-DD；没有明确日期填 null",
  "deadline_raw": "原文里关于截止的表述，原样抄下来",
  "channel_type": "投递渠道类型，只能填以下之一: email 邮箱 / link 网申链接 / wechat 公众号 / site 官网 / unknown",
  "channel_email": "如果是邮箱投递，填邮箱地址；否则填 ''",
  "channel_url": "如果能拿到网申或公告的 URL，填进来；否则填 ''",
  "channel_steps": "投递路径，一步一步写清楚，如 '关注公众号「XX招聘」→ 菜单「校园招聘」→ 选岗位投递'；拿不准填 ''",
  "industry":  "一句话行业标签，如 '物流' / '银行' / '医药'；不确定填 ''",
  "note":      "对求职者有用的补充，40字内（薪资/学历/笔试/是否接受往届）；没有填 ''",
  "url":       "招聘公告原文链接；没有填 ''"
}`;

function buildPrompt(payload) {
  const parts = [];
  const batch = payload.mode === 'list';

  // 清单模式：一次抽出 N 条。用来处理「30 家公司并列在一张截图里」那种盘点文。
  if (batch) {
    parts.push(
      '你是校园招聘信息提取助手。下面是一份**招聘盘点清单**（通常来自小红书/公众号，',
      '一行或一节一家公司，格式类似「公司名 base城市 截止时间」）。',
      '请把清单里**每一家公司**提取成一条记录，返回 JSON 数组。',
      '',
      '严格输出格式（只输出这个 JSON，不要解释、不要 markdown 代码块）：',
      '{"items":[ ' + SCHEMA_HINT + ', ... ]}',
      '',
      '严格要求：',
      '1. 一行/一家 = 一条。**清单里有几家就返回几条**，不要合并、不要漏。',
      '2. 不要编造。原文明说的才填，没写的字符串填 ""、数组填 []、日期填 null。',
      '3. 清单常只给「城市 + 截止」，没有岗位和专业 —— 那就留空，别硬凑。',
      '   留空的记录仍有价值：它告诉用户「这家公司在招，截止哪天」。',
      '4. 截止时间：',
      '   · "12月31日截止"  → deadline="' + new Date().getFullYear() + '-12-31"',
      '   · "27年3月7日截止" → deadline="2027-03-07"（前面带年份按年份）',
      '   · "招满即止"       → deadline=null，deadline_raw="招满即止"',
      '   · 已过去超过 60 天的无年份日期，视为下一年',
      '5. "base杭州" 这类前缀只取城市名："杭州"。',
      '6. 公司名去掉前面的序号、★、·；保留括号里的系属备注。',
      ''
    );
  } else {
    parts.push(
      '你是校园招聘公告的信息提取助手。把下面的招聘公告整理成一个 JSON 对象。',
      '',
      '严格要求：',
      '1. 只输出 JSON，不要任何解释、不要 markdown 代码块。',
      '2. 字段与类型如下：',
      SCHEMA_HINT,
      '3. **不要编造**。原文没写的字段，字符串填 ""、数组填 []、日期填 null。',
      '   宁缺毋滥：猜错的截止日会让人错过投递，比没有更糟。',
      '4. 年份判断：文案写"27届"通常指 2027 届；无年份的日期（如"10月19日"）',
      '   按当前年份 ' + new Date().getFullYear() + ' 年补全；若该日期已过去超过 60 天，',
      '   视为下一年并置 _deadline_uncertain=true。',
      '5. **投递渠道是重点**。中国校招大量用邮箱投递和微信公众号投递，',
      '   请仔细从原文里找 `邮箱地址`、URL、公众号名和菜单路径。',
      '   原文写了"投递至 xxx@yy.com"就填 channel_type=email + channel_email。',
      '   原文写了"关注XX公众号"就填 channel_type=wechat + channel_steps 写清路径。',
      '6. 如果内容明显不是招聘公告，返回 {"error":"not_a_job_posting"}。',
      ''
    );
  }

  if (payload.text) {
    parts.push(batch ? '【清单内容】' : '【公告文字】',
      String(payload.text).slice(0, 20000), '');
  }
  if (payload.source) parts.push('【来源】', String(payload.source), '');
  if (payload.source_url) parts.push('【来源链接】', String(payload.source_url), '');
  if (Array.isArray(payload.images) && payload.images.length) {
    parts.push('【图片】共 ' + payload.images.length +
      (batch ? ' 张招聘盘点截图，请从图中读出清单。' : ' 张招聘公告截图，请从图中读出信息。'));
  }

  return parts.join('\n');
}

async function callLLM(payload) {
  if (MOCK) return mockExtract(payload);

  // 清单模式：先试规则解析。规整清单（「公司 base城市 截止」）不用花 token。
  if (payload.mode === 'list') {
    const rule = parseListLines(payload.text);
    if (rule) {
      // normalizeItem 返回 {record, conf}，这里只要 record；
      // 规则解析出来的字段本来就干净，conf 基本是空的。
      const items = rule.map(x => normalizeItem(x, payload).record);
      return {
        ok: true,
        items,
        from: 'rule',
        confidence: {},
        _raw: '规则解析，未调用模型（识别到 ' + rule.length + ' 行规整清单）',
      };
    }
    // 规则认不出（格式乱），落到模型
  }

  if (!LLM_KEY) {
    const e = new Error('未配置 LLM_API_KEY');
    e.code = 'NO_KEY';
    throw e;
  }

  // 图文：要是有图就走视觉模型。
  // 文本模型（deepseek-chat / qwen-plus）吃不了图片，直接塞 image_url 会 400。
  // 没配视觉模型时，明确告诉用户「贴文字」，而不是发一个必然失败的请求。
  const hasImages = Array.isArray(payload.images) && payload.images.length > 0;
  const useVision = hasImages && payload.asVision !== false;

  if (useVision && !LLM_VISION_MODEL) {
    const e = new Error(
      '当前模型 ' + LLM_MODEL + ' 不支持图片。请把公告文字粘贴进来，' +
      '或在 .env.local 配置 LLM_VISION_MODEL（如 qwen-vl-max）。');
    e.code = 'NO_VISION';
    throw e;
  }

  let content;
  if (useVision) {
    content = [{ type: 'text', text: buildPrompt(payload) }];
    for (const img of payload.images.slice(0, 6)) {
      content.push({ type: 'image_url', image_url: { url: img } });
    }
  } else {
    content = buildPrompt(payload);
  }

  const model = useVision ? LLM_VISION_MODEL : LLM_MODEL;
  const batch = payload.mode === 'list';

  const res = await fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + LLM_KEY,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0,
      // 清单要输出更长，给足预算；不然 30 家会写到一半被截断
      max_tokens: batch ? 4000 : 1200,
      // 注意：清单模式要根为 {"items":[...]}，json_object 允许；
      // 但有些端点对数组根不支持，所以 prompt 里也明确要求包在 items 里。
      response_format: { type: 'json_object' },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const e = new Error('模型调用失败 HTTP ' + res.status + ': ' + text.slice(0, 300));
    e.code = 'LLM_HTTP';
    throw e;
  }

  let j;
  try { j = JSON.parse(text); } catch {
    throw new Error('模型返回不是 JSON: ' + text.slice(0, 200));
  }
  const raw = j?.choices?.[0]?.message?.content || '';
  return normalize(raw, payload);
}

/**
 * 单条记录的字段清洗。单条抽取和清单批量共用 —— 抄两遍迟早会漂。
 * 返回 { record, conf }，conf 是这个条目的警告。
 */
function normalizeItem(obj, payload) {
  const conf = {};
  const s = v => (typeof v === 'string' ? v.trim() : '');
  const arr = v => Array.isArray(v) ? v.map(s).filter(Boolean)
                  : (s(v) ? [s(v)] : []);

  const deadline = s(obj.deadline);
  const okDate = /^20\d{2}-\d{2}-\d{2}$/.test(deadline);
  if (deadline && !okDate) conf.deadline = '格式不合法，请人工核对';

  // 规则解析器会直接给出 deadline_kind（rolling 之类）；
  // 模型只给 deadline，kind 由有没有日期推出来。
  let deadline_kind = s(obj.deadline_kind);
  if (!['date', 'rolling', 'unknown'].includes(deadline_kind)) {
    deadline_kind = okDate ? 'date' : 'unknown';
  }

  // 投递渠道：类型白名单 + 一致性校验
  const CH = ['email', 'link', 'wechat', 'site', 'unknown'];
  let channel_type = CH.includes(s(obj.channel_type)) ? s(obj.channel_type) : 'unknown';
  const channel_email = s(obj.channel_email);
  const channel_url = s(obj.channel_url);
  const channel_steps = s(obj.channel_steps);

  // 警告要累积，不能互相覆盖。
  // 踩过的坑：原来三条判断都写 conf.channel = ...，
  // 结果「类型是邮箱但没抽到地址」总被「没抽到投递渠道」盖掉，
  // 更具体的信息反而看不到。
  const chWarn = [];

  // 先记下模型原本写的类型，再做纠正 —— 否则纠正完再判断「类型不对」永远是假。
  const declaredType = channel_type;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(channel_email) && channel_type !== 'email') {
    channel_type = 'email';
    chWarn.push('原文给了邮箱，类型已从 ' + declaredType + ' 修正为 email');
  }
  if (declaredType === 'email' && !channel_email) {
    chWarn.push('模型判为邮箱投递，但没抽到邮箱地址');
  }
  if (!channel_email && !channel_url && !channel_steps) {
    chWarn.push('没抽到任何投递渠道，请人工补');
  }
  if (chWarn.length) conf.channel = chWarn.join('；');

  return {
    record: {
      company: s(obj.company),
      title: s(obj.title),
      batch: s(obj.batch),
      positions: arr(obj.positions),
      majors: arr(obj.majors),
      work_content: s(obj.work_content),
      cities: arr(obj.cities),
      deadline: okDate ? deadline : null,
      deadline_kind,
      deadline_raw: s(obj.deadline_raw) || s(obj.deadline),
      channel_type,
      channel_email,
      channel_url,
      channel_steps,
      industry: s(obj.industry),
      note: s(obj.note),
      url: s(obj.url),
      source: s(payload.source),
      source_url: s(payload.source_url),
    },
    conf,
  };
}

function normalize(raw, payload) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // 模型偶尔包一层 markdown ```json
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型输出无法解析为 JSON: ' + raw.slice(0, 200));
    obj = JSON.parse(m[1] || m[0]);
  }

  if (obj.error) return { ok: false, error: obj.error, raw };

  // 清单模式：模型应返回 {items:[...]}。
  // 也容忍它直接返回裸数组（模型不总是听话）。
  if (payload.mode === 'list') {
    const items = Array.isArray(obj) ? obj
      : (Array.isArray(obj.items) ? obj.items
        : (Array.isArray(obj.records) ? obj.records : []));
    if (!items.length) {
      return { ok: false, error: '清单为空：模型没识别出任何岗位条目', raw };
    }
    const out = [];
    const allConf = {};
    items.forEach((it, i) => {
      const { record, conf } = normalizeItem(it, payload);
      if (!record.company) return;               // 没公司名的丢掉
      out.push(record);
      if (Object.keys(conf).length) allConf['#' + (i + 1) + ' ' + record.company] = conf;
    });
    if (!out.length) {
      return { ok: false, error: '清单里没有一条能抽出公司名', raw };
    }
    return { ok: true, items: out, confidence: allConf, _raw: raw };
  }

  const { record, conf } = normalizeItem(obj, payload);
  return { ok: true, record, confidence: conf, _raw: raw };
}

// ---------- mock（验证管道用，不调真模型） ----------

function mockExtract(payload) {
  const today = new Date();
  const soon = new Date(today.getTime() + 9 * 86400000).toISOString().slice(0, 10);
  return {
    ok: true,
    record: {
      company: '【MOCK】示例科技股份有限公司',
      title: '2027届校园招聘启动',
      batch: '27届秋招',
      positions: ['供应链管理培训生', '采购专员'],
      majors: ['工业工程', '物流管理', '机械工程'],
      work_content: '负责物料采购、交期跟催与供应商管理',
      cities: ['杭州', '嘉兴'],
      deadline: soon,
      deadline_raw: '10月30日截止',
      channel_type: 'email',
      channel_email: 'hr@example-mock.com',
      channel_url: 'https://example-mock.com/campus',
      channel_steps: '投递至 hr@example-mock.com，邮件标题「姓名+学校+岗位」',
      industry: '制造业',
      note: '本科可投，需 CET4，有笔试',
      url: payload.source_url || '',
      source: payload.source || 'MOCK 来源',
      source_url: payload.source_url || '',
    },
    confidence: { _mock: '这是 mock 数据，未调用真实模型' },
    _raw: JSON.stringify({ mock: true, note: '启动时加 --mock 才会走这条路径' }, null, 2),
  };
}



// ---------- 落库（单条/批量共用） ----------

/**
 * 把一条记录写进 data.jobs。已有同 id 就更新，没有就插到最前。
 * 返回最终写入的记录。**不负责写盘**（批量时只写一次）。\n */
function upsertJob(data, rec, id) {
  const idx = data.jobs.findIndex(j => j.id === id);
  const today = new Date().toISOString().slice(0, 10);
  const prev = idx >= 0 ? data.jobs[idx] : null;

  const merged = {
    id,
    company: rec.company,
    title: rec.title || '',
    batch: rec.batch || '27届秋招',
    positions: rec.positions || [],
    majors: rec.majors || [],
    work_content: rec.work_content || '',
    cities: rec.cities || [],
    city_defaulted: !!rec.city_defaulted,
    deadline: rec.deadline || null,
    // 有明确日期就是 date；否则尊重传入的 kind（rolling/unknown）
    deadline_kind: rec.deadline ? 'date' : (rec.deadline_kind || 'unknown'),
    deadline_raw: rec.deadline_raw || '',
    channel_type: rec.channel_type || 'unknown',
    channel_email: rec.channel_email || '',
    channel_url: rec.channel_url || '',
    channel_steps: rec.channel_steps || '',
    industry: rec.industry || '',
    note: rec.note || '',
    url: rec.url || '',
    starred: !!rec.starred,
    source: rec.source || '',
    source_url: rec.source_url || '',
    created: rec.created || today,
    updated: today,
  };

  // 采集来源元数据必须原样带过。
  // 少了 _src/_srcId，下次 collect --merge 就认不出这条是采集来的，
  // 会再插一条重复记录 —— 而失败表现是「都显示成功」，数据悄悄翻倍。
  // 同理，采集器写入的扩展字段（education/nationwide/published/bgs/overseas…）
  // 也不能因为不在白名单里就被星标操作抹掉。
  if (prev) {
    // 空值不覆盖：调用方只传了 company + starred 时，不能把 majors/cities 清空。
    // 前端点星标传的是完整对象，但 API 不能依赖「调用方一定传全」。
    const keepIfEmpty = ['positions', 'majors', 'cities', 'channel_email',
                         'channel_url', 'channel_steps', 'industry', 'note',
                         'url', 'source', 'source_url', 'deadline_raw'];
    for (const k of keepIfEmpty) {
      const v = merged[k];
      if ((v === '' || v == null || (Array.isArray(v) && !v.length)) && prev[k] !== undefined) {
        merged[k] = prev[k];
      }
    }
    if (!rec.deadline && prev.deadline) {
      merged.deadline = prev.deadline;
      merged.deadline_kind = prev.deadline_kind;
    }
    for (const k of Object.keys(prev)) {
      if (!(k in merged) && k !== 'updated') merged[k] = prev[k];
    }
  }
  for (const k of ['_src', '_srcId', 'education', 'nationwide', 'published',
                   'bgs', 'overseas', 'city_overseas_only', 'positionFamily',
                   'projectName', 'postId', 'jobDirection', 'jobCategory']) {
    if (rec[k] !== undefined && rec[k] !== '') merged[k] = rec[k];
    else if (prev && prev[k] !== undefined) merged[k] = prev[k];
  }

  if (idx >= 0) {
    merged.created = data.jobs[idx].created || merged.created;
    data.jobs[idx] = merged;
  } else {
    data.jobs.unshift(merged);   // 新录入的排最前
  }
  return merged;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true,
      mock: MOCK,
      llm: MOCK ? 'mock' : (LLM_KEY ? 'configured' : 'missing'),
      model: LLM_MODEL,
      // 只报 host，不回显完整 URL 和 key
      base: LLM_BASE.replace(/^https?:\/\//, '').split('/')[0],
      vision: LLM_VISION_MODEL || null,
      jobs: (await readData()).jobs.length,
    });
  }

  // 抽取
  if (p === '/api/extract' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    if (!body.text && !(body.images && body.images.length)) {
      return json(res, 400, { ok: false, error: '请提供 text 或 images' });
    }
    try {
      const r = await callLLM(body);
      return json(res, r.ok ? 200 : 422, r);    } catch (e) {
      if (e.code === 'NO_KEY') {
        return json(res, 503, {
          ok: false,
          error: '未配置 API key。请在项目根建 .env.local 写入 LLM_API_KEY=你的key 后重启服务。',
        });
      }
      if (e.code === 'NO_VISION') {
        return json(res, 400, { ok: false, error: e.message });
      }
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  // 落库（单条）
  if (p === '/api/jobs' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const rec = body.record || body;
    if (!rec.company) return json(res, 400, { ok: false, error: 'company 不能为空' });

    const data = await readData();
    const id = body.id || nextId(data.jobs);
    const merged = upsertJob(data, rec, id);
    await writeData(data);
    return json(res, 200, { ok: true, id, record: merged, total: data.jobs.length });
  }

  // 落库（批量，清单模式用）
  if (p === '/api/jobs/batch' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const list = Array.isArray(body.records) ? body.records : [];
    if (!list.length) return json(res, 400, { ok: false, error: 'records 为空' });

    // 上限保护：一次最多 200 条，防止误发一个巨大数组把文件写坏
    if (list.length > 200) {
      return json(res, 400, { ok: false, error: '一次最多保存 200 条，收到 ' + list.length });
    }

    const data = await readData();
    const ids = [];
    const skipped = [];
    for (const rec of list) {
      if (!rec || !rec.company) { skipped.push(rec && rec.company || '(无公司名)'); continue; }
      const id = nextId(data.jobs);
      upsertJob(data, rec, id);
      ids.push(id);
    }
    await writeData(data);
    return json(res, 200, {
      ok: true, ids, saved: ids.length, skipped,
      total: data.jobs.length,
    });
  }

  // 删除
  if (p.startsWith('/api/jobs/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/jobs/'.length));
    const data = await readData();
    const before = data.jobs.length;
    data.jobs = data.jobs.filter(j => j.id !== id);
    if (data.jobs.length === before) return json(res, 404, { ok: false, error: '未找到 ' + id });
    await writeData(data);
    return json(res, 200, { ok: true, total: data.jobs.length });
  }

  // 列表（给外部/插件用）
  if (p === '/api/jobs' && method === 'GET') {
    return json(res, 200, await readData());
  }

  // Excel 导入：上传 xlsx → 调 import-xlsx.py → 返回报告
  //
  // 为什么服务端调 python 而不是在 node 里解析 xlsx：
  //   项目零依赖，node 解 xlsx 要自己拆 zip+XML，几百行且易错。
  //   python 的 openpyxl 已经装好，import-xlsx.py 的表头模糊匹配也测过了。
  //   服务端只负责「存临时文件 → 跑脚本 → 读输出」，不重复实现解析。
  if (p === '/api/import-xlsx' && method === 'POST') {
    let body;
    try { body = await readBody(req, 64 * 1024 * 1024); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    if (!body.fileBase64) {
      return json(res, 400, { ok: false, error: '缺少 fileBase64' });
    }
    const buf = Buffer.from(body.fileBase64, 'base64');
    if (buf.length < 100) {
      return json(res, 400, { ok: false, error: '文件内容为空' });
    }
    if (buf.length > 50 * 1024 * 1024) {
      return json(res, 400, { ok: false, error: '文件超过 50MB' });
    }

    const tmpDir = path.join(__dirname, 'data', 'tmp-import');
    await fs.mkdir(tmpDir, { recursive: true });
    const safeName = String(body.filename || 'upload.xlsx')
      .replace(/[^\w.\-一-龥]/g, '_');
    const tmpFile = path.join(tmpDir, Date.now() + '-' + safeName);
    await fs.writeFile(tmpFile, buf);

    // 注意不能用 `-I`：隔离模式会忽略 PYTHONIOENCODING 等环境变量，
    // 中文输出还是会按 Windows 控制台的 GBK 编码，node 按 utf8 读就是乱码。
    // 用 `-X utf8` 强制 UTF-8 模式，这是实现层面的开关，不受 -I 影响。
    const pyArgs = ['-X', 'utf8', path.join(__dirname, 'scripts', 'import-xlsx.py'), tmpFile];
    if (body.save) pyArgs.push('--save');
    if (body.sheet) pyArgs.push('--sheet', String(body.sheet));
    if (body.source) pyArgs.push('--source', String(body.source));
    if (body.defaultCity) pyArgs.push('--default-city', String(body.defaultCity));

    const { spawn } = await import('node:child_process');
    const run = () => new Promise(resolve => {
      const ch = spawn('python', pyArgs, {
        cwd: __dirname,
        // Windows 控制台默认 GBK，中文输出会变乱码后再被我们按 utf8 读，双重损坏。
        // 强制 python 用 utf8 输出，node 这边也按 utf8 读，两边一致。
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let out = '', err = '';
      ch.stdout.on('data', d => { out += d.toString('utf8'); });
      ch.stderr.on('data', d => { err += d.toString('utf8'); });
      ch.on('close', code => resolve({ code, out, err }));
      ch.on('error', e => resolve({ code: -1, out: '', err: e.message }));
    });

    let r;
    try { r = await run(); }
    catch (e) {
      await fs.unlink(tmpFile).catch(() => {});
      return json(res, 500, { ok: false, error: '调用 python 失败：' + e.message });
    }
    await fs.unlink(tmpFile).catch(() => {});

    return json(res, 200, {
      ok: r.code === 0,
      exitCode: r.code,
      report: r.out,
      error: r.code === 0 ? '' : (r.err || r.out || '未知错误'),
    });
  }

  if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'Not Found' });

  return serveStatic(req, res, p);
}

function nextId(jobs) {
  let max = 0;
  for (const j of jobs) {
    const m = /^j-(\d+)$/.exec(j.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'j-' + String(max + 1).padStart(4, '0');
}

// ---------- 启动 ----------

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[error]', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: err.message });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  校招看板已启动');
  console.log('  看板   http://127.0.0.1:' + PORT + '/');
  console.log('  录入   http://127.0.0.1:' + PORT + '/intake.html');
  console.log('  模型   ' + (LLM_KEY ? LLM_MODEL + ' @ ' + LLM_BASE : '未配置 API key'));
  console.log('');
});
