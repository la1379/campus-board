/**
 * 采集适配器：京东校招官网
 *
 * 为什么能拿到：京东校招站是 SPA，前端渲染岗位列表时必须从后端拉 JSON。
 * 那个 JSON 口是公开的，不需要登录、不需要 key。
 *   POST https://campus.jd.com/api/wx/position/recommendPage
 *   { pageSize, pageIndex, parameter: { planIdList, recommendChannelPositionVoList:[{deptCode:""}] } }
 *
 * 实测 2026-11-21：返回 353 个在招岗位，3.3MB。
 * 实测 2026-11-22：353 个，字段未变。
 *
 * 用法：
 *   node scripts/collect-jd.mjs            → 拉到 data/jd-raw.json 并打印统计
 *   node scripts/collect-jd.mjs --merge    → 同时合并进 data/jobs.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeIntoJobs, today } from './lib-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'jd-raw.json');

const API = 'https://campus.jd.com/api/wx/position/recommendPage';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchAll() {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://campus.jd.com',
      'Referer': 'https://campus.jd.com/',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      pageSize: 1000,
      pageIndex: 0,
      parameter: {
        planIdList: null,
        recommendChannelPositionVoList: [{ deptCode: '' }],
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`京东接口 HTTP ${res.status}`);
  }
  const j = await res.json();
  if (!j.success) {
    throw new Error('京东接口返回 success=false: ' + JSON.stringify(j).slice(0, 200));
  }
  // body 是按部门分组的，每组的 channelPositionVoList 才是岗位
  const flat = [];
  for (const g of j.body || []) {
    for (const p of g.channelPositionVoList || []) {
      flat.push(p);
    }
  }
  return flat;
}

// 专业词表。只用来「识别已知专业名」，抽不到就返回空，不瞎猜。
// 2026-11-22 扩充：原表漏了 经管 / 管理科学与工程 / 运筹学 等 27 届文案高频词。
const MAJOR_WORDS = [
  // 工业工程 / 物流 / 供应链 —— 本项目主要目标方向
  '工业工程', '物流管理', '物流工程', '供应链管理', '采购管理', '管理科学与工程',
  '运筹学', '信息管理', '电子商务', '工程管理', '经管', '经济管理',
  // 机械 / 车辆 / 自动化
  '机械工程', '机械设计', '车辆工程', '自动化', '电气工程', '机电',
  '测控', '仪器', '过程装备', '材料科学', '材料', '高分子', '冶金', '航空',
  // 计算机 / 数据 / 电子
  '计算机', '软件工程', '统计学', '数学', '人工智能', '数据科学', '大数据',
  '电子信息', '通信工程', '信息安全', '网络安全', '物联网', '微电子', '集成电路',
  // 生化环材 / 医药
  '化学', '生物', '药学', '医学', '护理', '环境', '食品',
  // 商科 / 文科
  '会计', '财务管理', '金融', '经济学', '市场营销', '工商管理', '人力资源管理',
  '法学', '新闻传播', '广告', '心理学', '交互设计', '工业设计', '设计',
  '英语', '社会学', '土木', '建筑', '图书', '档案',
];

function guessMajors(qual) {
  const s = String(qual || '');
  if (/专业不限|不限专业/.test(s)) return ['不限'];
  const out = [];
  for (const w of MAJOR_WORDS) {
    if (s.includes(w)) out.push(w);
  }
  return out;
}

// 从 qualification 抽最低学历
function guessEducation(qual) {
  const s = String(qual || '');
  if (/博士/.test(s)) return '博士';
  if (/硕士|研究生/.test(s)) return '硕士';
  if (/本科|学士/.test(s)) return '本科';
  if (/大专|专科/.test(s)) return '大专';
  return '';
}

/**
 * 届数。
 *
 * 京东文案有两种写法，都必须认：
 *   "2027届"                          → 2027届
 *   "27届优先" / "2026年10月...毕业"   → 27 届即 2027 届
 *
 * 踩过的坑：只认 4 位年份，202 条里漏了 83 条「27届」，
 * 它们全是京东物流/运营类岗位 —— 正是最该被看到的那批。
 */
function guessBatch(qual) {
  const s = String(qual || '');
  let m = s.match(/(20\d{2})\s*届/);
  if (m) return m[1] + '届';
  m = s.match(/(20\d{2})[^0-9]{0,6}(20\d{2})\s*年?[^。]{0,20}毕业/);
  if (m) return m[1] + '届';
  m = s.match(/(20\d{2})\s*年.{0,8}毕业/);
  if (m) return m[1] + '届';
  // 两位数字届：24~29 才当届数，避免把"第3届"之类误判
  m = s.match(/([2][4-9])\s*届/);
  if (m) return '20' + m[1] + '届';
  return '';
}

/**
 * 城市清洗。
 *
 * 京东的 workCity 实际是三级结构（实测 300 种取值）：
 *   "北京市-北京市"          直辖市，两段同一个
 *   "四川省-成都市"          普通省-市
 *   "广东省-深圳市-南山区"    带区
 *   "新疆维吾尔自治区-乌鲁木齐市"
 *
 * 所以**市在第二段**（直辖市取第一段去"市"）。第一段永远是省，不能直接用。
 */
function cleanCity(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';

  const parts = s.split('-').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return '';

  const stripSuffix = x => x.replace(/(省|市|维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区)$/, '');

  // 直辖市：两段相同，或第一段是直辖市
  const MUNI = ['北京', '上海', '天津', '重庆'];
  const p0 = stripSuffix(parts[0]);
  if (MUNI.includes(p0)) return p0;

  // 普通省份：取第二段
  const cityPart = parts.length >= 2 ? parts[1] : parts[0];
  const city = stripSuffix(cityPart);

  // 兜底：如果切出来还是"自治州/地区/盟"这种非市单位，保留原样（有信息好过丢弃）
  return city || '';
}

function normalize(p) {
  const qual = p.qualification || '';

  // 城市：requirementVoList 里每条有 workCity，去重后只留真城市
  const citySet = new Set();
  for (const rv of p.requirementVoList || []) {
    const c = cleanCity(rv && rv.workCity);
    if (c) citySet.add(c);
  }

  const content = String(p.workContent || '').trim();
  const cities = [...citySet];
  // 挂 60+ 城市的多半是「全国招」（如营业部站长、业务拓展），
  // 这是真实信息不是脏数据，打标记让界面能特殊展示。
  const nationwide = cities.length > 60;

  const pub = p.publishTime ? new Date(p.publishTime) : null;

  return {
    // 溯源：所有字段都来自哪
    _src: 'jd',
    _srcId: p.publishId || p.reqId || null,
    company: '京东',
    title: p.positionName || p.positionNameOpen || '',
    batch: guessBatch(qual) || '',
    positions: [p.positionName].filter(Boolean),
    majors: guessMajors(qual),
    work_content: firstSentence(content),
    cities,
    nationwide,
    education: guessEducation(qual),
    // 京东接口不返回截止日。留空 + unknown，不猜 —— 猜错的截止日比没有更糟。
    deadline: null,
    deadline_kind: 'unknown',
    deadline_raw: '',
    industry: '互联网/电商',
    jobDirection: p.jobDirection || '',
    jobCategory: p.jobCategory || '',
    // 只留日期，不留毫秒数：主数据里的时间必须是「人能读、不随格式化漂移」的
    published: pub && !isNaN(pub) ? pub.toISOString().slice(0, 10) : '',
    // 京东整站统一走官网，没有单独公告 URL（detail 页要 id，未验证）
    channel_type: 'site',
    channel_email: '',
    channel_url: 'https://campus.jd.com/',
    channel_steps: '京东校招官网 → 职位 → 搜索岗位名 → 投递',
    note: '',
    source: '京东校招官网 API',
    source_url: 'https://campus.jd.com/',
    // 原始长文本留在 raw 文件里备查
    qualification: qual,
    workContent: content,
  };
}

function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // 去掉开头的编号
  const clean = t.replace(/^[0-9]+[.、）)]\s*/, '');
  const m = clean.match(/^[^。；;\n]{6,60}/);
  return m ? m[0] : clean.slice(0, 60);
}

async function main() {
  const merge = process.argv.includes('--merge');

  console.log('拉取京东校招岗位…');
  const raw = await fetchAll();
  console.log('  原始岗位数:', raw.length);

  if (!raw.length) {
    console.error('X 拿到 0 条，接口可能变了。先别继续。');
    process.exit(1);
  }

  // 先验字段完整性（验证纪律：先确认读到了东西，再断言内容）
  console.log('  有岗位名:', raw.filter(p => p.positionName).length);
  console.log('  有招聘要求原文:', raw.filter(p => p.qualification).length);

  const jobs = raw.map(normalize);

  const stats = {
    total: jobs.length,
    withCities: jobs.filter(j => j.cities.length).length,
    withMajors: jobs.filter(j => j.majors.length).length,
    withBatch: jobs.filter(j => j.batch).length,
    withoutName: jobs.filter(j => !j.title).length,
  };
  console.log('  有城市:', stats.withCities, '/', stats.total);
  console.log('  抽到专业:', stats.withMajors, '/', stats.total);
  console.log('  抽到届数:', stats.withBatch, '/', stats.total);

  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await fs.writeFile(RAW, JSON.stringify({
    fetched: new Date().toISOString(),
    count: jobs.length,
    jobs,
  }, null, 2), 'utf8');
  console.log('  写入 data/jd-raw.json');

  if (merge) {
    await mergeIntoJobs(ROOT, jobs, { src: 'jd' });
  }
}

main().catch(e => {
  console.error('X 失败:', e.message);
  process.exit(1);
});
