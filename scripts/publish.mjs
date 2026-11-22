/**
 * 发布：把数据烤进静态 HTML，产出可直接扔到 Cloudflare Pages / GitHub Pages 的 dist/。
 *
 * 为什么是「烤数据」而不是「接个 API」：
 *   实测本机网络（2026-11-21）：pages.dev / github.io 通，workers.dev / vercel / supabase 全超时。
 *   也就是说不存在一个「够得着的免费动态后端」。那就只能静态托管 + 数据内联。
 *
 * 内联方式：在 index.html 的 </head> 前插一段 <script>，写 window.__JOBS__ 和
 * window.__PROFILE__。app.js 已经优先读 window.__JOBS__（见 loadData 第 1 分支），
 * 所以不用改一行业务代码。
 *
 * 静态版的取舍（都写在页面上告诉用户，不藏）：
 *   · 星标存 localStorage（没有后端可写）
 *   · 录入器不带（它要调模型，必须有后端和 key）
 *
 * 用法：
 *   node scripts/publish.mjs               → 生成 dist/
 *   node scripts/publish.mjs --open        → 生成并打印本地预览地址
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 发布去掉长文本，让 HTML 别到 1MB 以上。
// 注意：只去「界面上根本用不到」的字段，判据是 app.js 里有没有读它。
const DROP = ['qualification', 'workContent'];
// 发布版拿不到后端，删掉反而让页面小一半：投递路径文案已由 channel_url/steps 表达
const MAX_JSON_BYTES = 3 * 1024 * 1024;

async function readJSON(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { return fallback; }
}

function slimJobs(data) {
  const jobs = (data.jobs || []).map(j => {
    const o = {};
    for (const [k, v] of Object.entries(j)) {
      if (DROP.includes(k)) continue;
      o[k] = v;
    }
    return o;
  });
  return { version: data.version || 2, updated: data.updated || '', jobs };
}

// 静态版拿不到后端，删掉依赖后端的功能入口。
// 不删的话用户点「录入」「导入」会看到 404，以为站坏了。
function stripAdminLinks(html) {
  return html.replace(
    /<!-- 静态版会被 publish\.mjs 删掉这段[^>]*-->\s*<span id="adminLinks"[\s\S]*?<\/span>/,
    ''
  );
}

function inject(html, payload) {
  const block =
    '\n<!-- 发布构建注入（scripts/publish.mjs）：数据与档案内联，静态站无需后端 -->\n' +
    '<script>\n' +
    'window.__STATIC__ = true;\n' +
    'window.__JOBS__ = ' + JSON.stringify(payload.data) + ';\n' +
    'window.__PROFILE__ = ' + JSON.stringify(payload.profile) + ';\n' +
    '</script>\n';
  if (html.includes('</head>')) return html.replace('</head>', block + '</head>');
  return block + html;
}

// 静态版页脚要说实话：星标只存在本机，录入器不可用
function patchFooter(html) {
  return html.replace(
    /<span>数据为人工录入，投递前请到官方渠道复核截止时间<\/span>/,
    '<span>投递前请到官方渠道复核截止时间 · 星标只存在你这台设备 · 本页是静态快照，不会自动更新</span>'
  );
}

function patchVersion(html, stamp) {
  return html.replace(/<title>校招看板<\/title>/,
    '<title>校招看板</title>\n<meta name="generator" content="publish.mjs ' + stamp + '">');
}

async function main() {
  const data = await readJSON(path.join(ROOT, 'data', 'jobs.json'), null);
  if (!data || !Array.isArray(data.jobs) || !data.jobs.length) {
    console.error('X data/jobs.json 为空或不存在，先跑采集或迁移');
    process.exit(1);
  }
  const profile = await readJSON(path.join(ROOT, 'data', 'profile.json'), {
    majors: [], cities: [], directions: [], batch: '', education: '',
    _weights: { major: 0.4, city: 0.3, direction: 0.3 },
  });

  const slim = slimJobs(data);
  const payload = { data: slim, profile };
  const jsonSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (jsonSize > MAX_JSON_BYTES) {
    console.error(`X 内联数据 ${(jsonSize / 1048576).toFixed(1)}MB，超过 ${MAX_JSON_BYTES / 1048576}MB 上限`);
    process.exit(1);
  }

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  html = stripAdminLinks(html);
  html = inject(html, payload);
  html = patchFooter(html);
  html = patchVersion(html, stamp);
  await fs.writeFile(path.join(DIST, 'index.html'), html, 'utf8');

  await fs.copyFile(path.join(ROOT, 'app.js'), path.join(DIST, 'app.js'));
  await fs.copyFile(path.join(ROOT, 'style.css'), path.join(DIST, 'style.css'));

  // 静态托管不需要路由规则，但加一个说明文件，免得以后自己忘了怎么更新
  await fs.writeFile(path.join(DIST, 'README.txt'),
    '校招看板静态版\n' +
    '生成时间：' + stamp + '\n' +
    '数据：' + slim.jobs.length + ' 条\n' +
    '更新方式：回项目根跑 node scripts/publish.mjs，再把 dist/ 整个传上去\n' +
    '注意：本版无后端，星标存浏览器 localStorage，录入器不可用。\n', 'utf8');

  console.log('  数据条数   : ' + slim.jobs.length);
  console.log('  内联大小   : ' + (jsonSize / 1024).toFixed(0) + ' KB');
  console.log('  产物       : dist/index.html, dist/app.js, dist/style.css');
  const htmlSize = Buffer.byteLength(html, 'utf8');
  console.log('  index.html : ' + (htmlSize / 1024).toFixed(0) + ' KB');

  if (process.argv.includes('--open')) {
    console.log('\n  本地预览（file:// 也能跑，因为数据已内联）:');
    console.log('  ' + path.join(DIST, 'index.html'));
  }
}

main().catch(e => {
  console.error('X 发布失败:', e.message);
  process.exit(1);
});
