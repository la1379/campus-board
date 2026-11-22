/**
 * 采集适配器：腾讯校招官网
 *
 * 接口实测（2026-11-21 首验，2026-11-22 复验仍通）：
 *   POST https://join.qq.com/api/v1/position/searchPosition?timestamp=<毫秒>
 *   Referer: https://join.qq.com/post.html
 *   无签名、无 token、无登录
 *
 * 实测 2026-11-22：count=1007，pageSize=500 → 3 页取完（500/500/7）。
 *
 * 它比京东「瘦」：只有 岗位名 + 城市 + 事业群 + 项目名，
 * **没有专业要求、没有岗位描述、没有截止日**。
 * 详情页 detail.html?postId=xxx 未登录只有 141 字符 —— 不绕过登录墙，所以拿不到。
 *
 * 用法：
 *   node scripts/collect-qq.mjs            → 拉到 data/qq-raw.json
 *   node scripts/collect-qq.mjs --merge    → 同时合并进 data/jobs.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeIntoJobs } from './lib-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'qq-raw.json');

const API = 'https://join.qq.com/api/v1/position/searchPosition';
const PAGE_SIZE = 500;
const MAX_PAGES = 20;            // 兜底，防止接口 count 异常时死循环

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchPage(pageIndex) {
  const res = await fetch(API + '?timestamp=' + Date.now(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://join.qq.com',
      'Referer': 'https://join.qq.com/post.html',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      projectIdList: [],
      projectMappingIdList: [1, 2, 104, 14, 20],
      keyword: '',
      bgList: [],
      workCountryType: 0,
      workCityList: [],
      recruitCityList: [],
      positionFidList: [],
      pageIndex,
      pageSize: PAGE_SIZE,
    }),
  });
  if (!res.ok) throw new Error(`腾讯接口 HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 0 && j.status !== '0') {
    throw new Error('腾讯接口 status 非 0: ' + JSON.stringify(j).slice(0, 200));
  }
  const d = j.data || {};
  return { list: d.positionList || [], count: d.count || 0 };
}

async function fetchAll() {
  const out = [];
  const seen = new Set();
  let count = 0;

  for (let p = 1; p <= MAX_PAGES; p++) {
    const r = await fetchPage(p);
    count = r.count || count;
    if (!r.list.length) break;
    for (const x of r.list) {
      if (seen.has(x.id)) continue;   // 分页偶有重叠，按 id 去重
      seen.add(x.id);
      out.push(x);
    }
    console.log('  第 ' + p + ' 页: +' + r.list.length + ' (累计 ' + out.length + '/' + count + ')');
    if (out.length >= count || r.list.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * 城市清洗。
 *
 * 腾讯的 workCities 是**空格分隔的字符串**，而且英文地名里本身带空格：
 *   "深圳总部 北京 上海"                                   → 3 个
 *   "Australia-New South Wales-Sydney 北京"                → 2 个，不是 5 个
 *   "Japan-Tokyo-Business Tower"                           → 1 个，不是 3 个
 *
 * 规则：只有「纯 ASCII token 紧跟在纯 ASCII token 之后」才并入上一个城市，
 * 其余一律视为新城市起点。
 *
 * 踩过的两个坑（都是实测踩出来的）：
 *   1. 只看 "-" 当边界 → "深圳总部 北京 上海" 被拼成 "深圳总部 北京"。
 *      中文城市之间永远靠空格分隔，所以非 ASCII token 必须无条件当新起点。
 *   2. 直接 split(/\s+/) → "Australia-New South Wales-Sydney" 被切成
 *      Australia-New / South / Wales-Sydney 三段，产出 South、Tower 这种假城市。
 */
function splitCities(raw) {
  const isAscii = t => /^[\x20-\x7e]+$/.test(t);
  const toks = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = null;
  for (const t of toks) {
    if (cur && isAscii(cur) && isAscii(t)) {
      cur += ' ' + t;              // 英文地名内部的空格
    } else {
      if (cur) out.push(cur);
      cur = t;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 深圳总部 → 深圳；中国香港保留 */
function cnCity(t) {
  if (t === '深圳总部') return '深圳';
  return t.replace(/总部$/, '');
}

/** "US-California-Palo Alto" → "美国-加州-Palo Alto"，原样保留便于识别海外岗 */
function isOverseas(t) {
  return /[A-Za-z]/.test(t) && !/^China-/.test(t);
}

function normalize(x) {
  const rawCities = splitCities(x.workCities);
  const cities = [];
  const overseas = [];
  for (const t of rawCities) {
    if (isOverseas(t)) { overseas.push(t); continue; }
    if (/^China-/.test(t)) { cities.push('深圳'); continue; }  // China-Shenzhen
    cities.push(cnCity(t));
  }

  const bgs = String(x.bgs || '').trim().split(/\s+/).filter(Boolean);

  // 只挂海外城市（如新加坡岗）的记录，国内城市为空 —— 这不是脏数据，
  // 但要能和「城市没抽到」区分开，所以单独留 overseas 并在 city_defaulted 里注明来源。
  const cn = [...new Set(cities)];
  const isOverseasOnly = !cn.length && overseas.length > 0;

  return {
    _src: 'qq',
    _srcId: x.id,
    company: '腾讯',
    title: x.positionTitle || '',
    // 项目名当批次：应届毕业生 / 青云计划-应届生 / 应届实习 / 日常实习
    batch: x.projectName || '',
    positions: [x.positionTitle].filter(Boolean),
    // 腾讯接口不返回专业和岗位描述 —— 留空，不编造
    majors: [],
    work_content: '',
    cities: cn.length ? cn : (isOverseasOnly ? ['海外'] : []),
    overseas,
    city_overseas_only: isOverseasOnly,
    bgs,
    positionFamily: x.positionFamily == null ? null : x.positionFamily,
    projectName: x.projectName || '',
    industry: '互联网',
    // 腾讯接口同样不返回截止日 —— 留空，不猜
    deadline: null,
    deadline_kind: 'unknown',
    deadline_raw: '',
    // 腾讯详情页需登录，拿不到公告原文；用搜索页做投递路径
    channel_type: 'site',
    channel_email: '',
    channel_url: 'https://join.qq.com/post.html',
    channel_steps: '腾讯校招官网 → 岗位搜索 → 搜「' + (x.positionTitle || '') + '」→ 投递',
    postId: x.postId || '',
    note: x.projectName === '应届毕业生' || /青云计划/.test(x.projectName || '')
      ? '应届批（可投）' : '实习批',
    source: '腾讯校招官网 API',
    source_url: 'https://join.qq.com/post.html',
  };
}

async function main() {
  const merge = process.argv.includes('--merge');

  console.log('拉取腾讯校招岗位…');
  const raw = await fetchAll();
  console.log('  原始记录数:', raw.length);
  if (!raw.length) {
    console.error('X 拿到 0 条，接口可能变了。先别继续。');
    process.exit(1);
  }

  const jobs = raw.map(normalize);

  const projects = {};
  for (const j of jobs) projects[j.batch] = (projects[j.batch] || 0) + 1;
  const allCities = new Set();
  for (const j of jobs) j.cities.forEach(c => allCities.add(c));
  const withOverseas = jobs.filter(j => j.overseas.length).length;

  console.log('  项目分布:', JSON.stringify(projects));
  console.log('  国内城市种类:', allCities.size);
  console.log('  含海外岗:', withOverseas, '/', jobs.length);
  console.log('  有岗位名:', jobs.filter(j => j.title).length);
  // 脏数据哨兵：这些是实测出现过的切分错误产物
  const junk = [...allCities].filter(c => ['New', 'Wales', 'Tower', 'United', 'Kingdom'].includes(c));
  if (junk.length) {
    console.error('X 城市切分产出垃圾 token:', junk.join(','), '—— 检查 splitCities');
    process.exit(1);
  }

  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await fs.writeFile(RAW, JSON.stringify({
    fetched: new Date().toISOString(),
    count: jobs.length,
    jobs,
  }, null, 2), 'utf8');
  console.log('  写入 data/qq-raw.json');

  if (merge) {
    await mergeIntoJobs(ROOT, jobs, { src: 'qq' });
  }
}

main().catch(e => {
  console.error('X 失败:', e.message);
  process.exit(1);
});
