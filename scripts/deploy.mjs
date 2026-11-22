/**
 * 一键部署到 GitHub Pages。
 *
 * 做的事：publish 生成 dist/ → 推送到 gh-pages 分支 → 打印网址。
 *
 * 实现方式说明（踩过的坑）：
 *   最早用 `git worktree add --orphan -b gh-pages` 建临时目录再提交推送。
 *   在 Windows 上这条路会反复失败：
 *     · 项目路径含中文，`git -C "<中文路径>"` 偶尔解析错
 *     · orphan 分支在没有 commit 时没有 ref，push 报 src refspec does not match any
 *     · worktree 目录被占用时删不掉（Device or resource busy）
 *   现在改成：**用一个独立的临时 git 仓库**（git init 在系统临时目录），
 *   从那里 force push 到 gh-pages。路径全英文，不碰主仓库的工作树。
 *
 * 用法：
 *   node scripts/deploy.mjs                  → 生成并推送
 *   node scripts/deploy.mjs --dry-run        → 只生成，不推送
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

function sh(cmd, cwd, opts = {}) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}
function cap(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, shell: true, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

console.log('');
console.log('  校招看板 · 部署到 GitHub Pages');
console.log('');

// ---------- 1. 生成 dist ----------
console.log('  [1/4] 生成静态站…');
sh('node scripts/publish.mjs --blank-profile', ROOT);
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

// ---------- 2. 从主仓库读远端 ----------
console.log('');
console.log('  [2/4] 检查远端…');

const isRepo = cap('git rev-parse --is-inside-work-tree', ROOT) === 'true';
if (!isRepo) {
  console.error('X 还没初始化 git。步骤见 scripts/DEPLOY.md');
  process.exit(1);
}

const remote = cap('git remote get-url origin', ROOT);
if (!remote) {
  console.error('X 没有 remote origin。先配：');
  console.error('    git remote add origin git@github.com:<你>/<仓库>.git');
  process.exit(1);
}
console.log('  origin: ' + remote);

function pagesUrl(r) {
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(r);
  return m ? 'https://' + m[1] + '.github.io/' + m[2] + '/' : '';
}
const URL = pagesUrl(remote);

// ---------- 3. 在系统临时目录建一个独立仓库来发布 ----------
console.log('');
console.log('  [3/4] 推送到 gh-pages…');

// 用系统临时目录，路径保证是纯英文
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-deploy-'));

try {
  sh('git init -q', TMP, { quiet: true });
  sh('git checkout -q -b gh-pages', TMP, { quiet: true });

  // 拷 dist 内容
  for (const name of fs.readdirSync(DIST)) {
    fs.cpSync(path.join(DIST, name), path.join(TMP, name), { recursive: true });
  }
  // 跳过 Jekyll（否则下划线开头的文件会被忽略）
  fs.writeFileSync(path.join(TMP, '.nojekyll'), '');

  sh('git add -A', TMP, { quiet: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  sh(`git -c user.name="deploy-bot" -c user.email="deploy@local" commit -q -m "deploy ${stamp}"`,
     TMP, { quiet: true });

  sh(`git remote add origin "${remote}"`, TMP, { quiet: true });
  sh('git push origin gh-pages --force', TMP);

  console.log('  已推送（' + fs.readdirSync(TMP).length + ' 个文件）');
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }
}

// ---------- 4. 提示 ----------
console.log('');
console.log('  [4/4] 完成');
console.log('');
if (URL) {
  console.log('  网址  ' + URL);
  console.log('');
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote);
  if (m) {
    console.log('  第一次发布还需要开启 Pages（只需一次）：');
    console.log(`    gh api -X POST repos/${m[1]}/${m[2]}/pages -f "source[branch]=gh-pages" -f "source[path]=/"`);
  }
  console.log('');
  console.log('  生效通常 30 秒到 1 分钟（CDN 有缓存）。');
  console.log('  之后每次改完数据，npm run deploy 即可，同学刷新就是新的。');
}
console.log('');
