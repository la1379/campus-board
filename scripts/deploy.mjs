/**
 * 一键部署到 GitHub Pages。
 *
 * 做的事：publish 生成 dist/ → 推到 gh-pages 分支 → 打印网址。
 * 用 git 的 orphan 分支技巧，不改动 main 的分支历史，
 * 也不用把 dist/ 加进 .gitignore 之外的特殊配置。
 *
 * 用法：
 *   node scripts/deploy.mjs                  → 生成并推送
 *   node scripts/deploy.mjs --dry-run        → 只生成，不推送
 *   node scripts/deploy.mjs --repo owner/name → 首次自动建仓库并配置
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : '';

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function capture(cmd) {
  try {
    return execFileSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function has(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

console.log('');
console.log('  校招看板 · 部署到 GitHub Pages');
console.log('');

// ---------- 1. 生成 dist ----------
console.log('  [1/4] 生成静态站…');
run('node scripts/publish.mjs', { stdio: 'inherit' });
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('X dist/index.html 没生成，停下');
  process.exit(1);
}

if (DRY) {
  console.log('');
  console.log('  预览模式：dist/ 已生成，未推送。');
  console.log('  本地看：' + path.join(DIST, 'index.html'));
  process.exit(0);
}

// ---------- 2. 检查 git 与远端 ----------
console.log('');
console.log('  [2/4] 检查 git…');

const isRepo = capture('git rev-parse --is-inside-work-tree') === 'true';
if (!isRepo) {
  console.error('X 还没初始化 git。先跑一次：');
  console.error('    git init && git add . && git commit -m "init"');
  console.error('    git branch -M main');
  console.error('    git remote add origin git@github.com:<你>/<仓库>.git');
  console.error('    git push -u origin main');
  console.error('  详细步骤见 scripts/DEPLOY.md');
  process.exit(1);
}

let remote = capture('git remote get-url origin');
if (!remote && repoArg && has('gh')) {
  console.log('  没配 origin，按 --repo 创建…');
  run(`gh repo create ${repoArg} --public --source=. --remote=origin --push`, { stdio: 'inherit' });
  remote = capture('git remote get-url origin');
}
if (!remote) {
  console.error('X 没有 remote origin。先配：');
  console.error('    git remote add origin git@github.com:<你>/<仓库>.git');
  process.exit(1);
}
console.log('  origin: ' + remote);

// 从 remote 推断 Pages 地址
function pagesUrl(remote) {
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/.exec(remote);
  if (!m) return '';
  return 'https://' + m[1] + '.github.io/' + m[2] + '/';
}
const URL = pagesUrl(remote);

// ---------- 3. 用工作树方式发布，不污染 main ----------
console.log('');
console.log('  [3/4] 推送到 gh-pages…');

// 用临时工作树把 dist/ 的内容放到 gh-pages 分支。
// 为什么这么做：dist/ 在 .gitignore 里，直接 git add -f 会把 dist 塞进 main 历史，
// 以后每次发布都多一份 1MB 的 HTML，仓库很快膨胀。
// 单独分支只保留"最新一版"，历史干净。
const WT = path.join(ROOT, '.deploy-wtmp');
const hasGhp = capture('git ls-remote --heads origin gh-pages');
const hasLocalGhp = capture('git branch --list gh-pages');

try {
  if (fs.existsSync(WT)) fs.rmSync(WT, { recursive: true, force: true });

  if (hasGhp || hasLocalGhp) {
    run(`git worktree add "${WT}" gh-pages`, { stdio: 'pipe' });
  } else {
    run(`git worktree add --orphan -b gh-pages "${WT}"`, { stdio: 'pipe' });
  }

  // 清空旧内容（保留 .git）
  for (const name of fs.readdirSync(WT)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(WT, name), { recursive: true, force: true });
  }
  // 拷 dist 内容
  for (const name of fs.readdirSync(DIST)) {
    fs.cpSync(path.join(DIST, name), path.join(WT, name), { recursive: true });
  }
  // GitHub Pages 默认会跑 Jekyll，加这个文件跳过，免得下划线文件被忽略
  fs.writeFileSync(path.join(WT, '.nojekyll'), '');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  run('git add -A', { cwd: WT, stdio: 'pipe' });
  let committed = false;
  try {
    execSync(`git -C "${WT}" commit -m "deploy ${stamp}"`, { stdio: 'pipe' });
    committed = true;
  } catch {
    // 内容没变，没有 commit 可做 —— 不是错误
  }

  if (committed) {
    run(`git -C "${WT}" push origin gh-pages --force`, { stdio: 'inherit' });
    console.log('  已推送');
  } else {
    console.log('  内容没变化，跳过推送');
  }
} finally {
  try {
    run(`git worktree remove "${WT}" --force`, { stdio: 'pipe' });
  } catch { /* 清理失败不影响结果 */ }
  if (fs.existsSync(WT)) fs.rmSync(WT, { recursive: true, force: true });
}

// ---------- 4. 提示 ----------
console.log('');
console.log('  [4/4] 完成');
console.log('');
if (URL) {
  console.log('  网址  ' + URL);
  console.log('');
  console.log('  如果这是第一次发布，需要先在仓库里开启 Pages：');
  console.log('    仓库 → Settings → Pages → Source 选 gh-pages 分支');
  console.log('  或跑一次：');
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/.exec(remote);
  if (m) {
    console.log(`    gh api -X POST repos/${m[1]}/${m[2]}/pages -f "source[branch]=gh-pages" -f "source[path]=/"`);
  }
  console.log('');
  console.log('  生效通常要 30 秒到 1 分钟（CDN 有缓存）。');
  console.log('  之后每次改完数据，跑 npm run deploy 即可，同学刷新就是新的。');
}
console.log('');
