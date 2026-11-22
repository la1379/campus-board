/**
 * 采集结果 → data/jobs.json 的共享入库逻辑。
 *
 * 为什么单独一个文件：京东/腾讯两家的「抽取字段」完全不同，但「怎么并进主数据」
 * 必须完全一样 —— 尤其是幂等键 (_src + _srcId)。抄两遍迟早会漂移。
 *
 * 两条规则：
 *   1. 幂等：同一 (_src, _srcId) 只更新不新增。丢了幂等键，重跑一次数据就翻倍。
 *   2. 新值非空才覆盖：采集器抽不到的东西（如空数组）不能把用户手填的内容抹掉。
 *      用户在看板里补的截止日、备注，重采集之后必须还在。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// 原始长文本只留在 *-raw.json 里，不进主数据。
// 主数据是要被整页加载（将来还要内联进 HTML）的，不能塞 1MB 的招聘原文。
const PRUNE = ['qualification', 'workContent'];

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nextId(jobs) {
  let max = 0;
  for (const j of jobs) {
    const m = /^j-(\d+)$/.exec(j.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'j-' + String(max + 1).padStart(5, '0');
}

function isEmpty(v) {
  return v === '' || v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0);
}

function slim(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (PRUNE.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 新记录覆盖旧记录，但空值不覆盖 —— 保护用户手填内容 */
function mergeRecord(old, nw) {
  const out = { ...old };
  for (const [k, v] of Object.entries(nw)) {
    if (k === 'id' || k === 'starred' || k === 'created') continue; // 用户态/身份不动
    if (isEmpty(v) && !isEmpty(old[k])) continue;                   // 空值不覆盖
    out[k] = v;
  }
  out.updated = today();
  return out;
}

export async function mergeIntoJobs(ROOT, incoming, opts = {}) {
  const JOBS = path.join(ROOT, 'data', 'jobs.json');
  const SRC = opts.src || '(unknown)';

  let data;
  try {
    data = JSON.parse(await fs.readFile(JOBS, 'utf8'));
  } catch {
    data = { version: 2, updated: today(), origin: 'collector', jobs: [] };
  }
  if (!Array.isArray(data.jobs)) data.jobs = [];

  // 改大文件前留一份快照。合并是「不可逆的多写」，出错时得能退回去。
  if (data.jobs.length) {
    const dir = path.join(ROOT, 'data', 'backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fs.writeFile(path.join(dir, `jobs-${stamp}.json`),
      JSON.stringify(data, null, 2), 'utf8');
  }

  const before = data.jobs.length;
  const byKey = new Map();
  for (const j of data.jobs) {
    if (j._src && j._srcId != null) byKey.set(j._src + ':' + j._srcId, j);
  }

  let added = 0, updated = 0, skipped = 0;
  for (const raw of incoming) {
    if (raw._srcId == null || raw._srcId === '') { skipped++; continue; }
    const nw = slim(raw);
    const key = nw._src + ':' + nw._srcId;
    const old = byKey.get(key);
    if (old) {
      const merged = mergeRecord(old, nw);
      Object.assign(old, merged);
      updated++;
    } else {
      const rec = {
        ...nw,
        id: nextId(data.jobs),
        starred: false,
        created: today(),
        updated: today(),
      };
      data.jobs.push(rec);
      byKey.set(key, rec);
      added++;
    }
  }

  data.updated = today();
  data.jobs.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const tmp = JOBS + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, JOBS);

  console.log('  merge[' + SRC + ']: +' + added + ' new, ' +
    updated + ' updated, ' + skipped + ' skipped(no _srcId), ' +
    before + ' -> ' + data.jobs.length);
  return { added, updated, skipped, total: data.jobs.length };
}
