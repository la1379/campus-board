/**
 * 从 cc-switch 的 provider 配置里导入 key 到本项目的 .env.local。
 *
 * 为什么要有这个脚本：
 *   key 不该在对话里明文出现（会被记进聊天记录、日志、可能被缓存）。
 *   这个脚本读 cc-switch 的库、写 .env.local，全程不回显 key 明文，
 *   只打印掩码。
 *
 * 用法：
 *   node scripts/import-key.mjs                 # 自动找第一个阿里云/百炼 provider
 *   node scripts/import-key.mjs --list          # 只列出找到哪些 provider
 *   node scripts/import-key.mjs --provider <id> # 指定某个
 *
 * 安全：默认只写 .env.local（已在 .gitignore），不落任何其他文件。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.env.local');

const CC = path.join(os.homedir(), '.cc-switch');
const DB = path.join(CC, 'cc-switch.db');

// 阿里云百炼（DashScope）的 OpenAI 兼容端点。
// 注意结尾没有 /v1 —— server.mjs 自己拼 /chat/completions，
// 而 DashScope 的兼容路径是 /compatible-mode/v1/chat/completions。
const ALIYUN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function mask(k) {
  if (!k) return '(空)';
  if (k.length <= 12) return k.slice(0, 3) + '***';
  return k.slice(0, 6) + '…' + k.slice(-4) + ' (len=' + k.length + ')';
}

/**
 * cc-switch 用 SQLite 存 provider。这里不引 sqlite 依赖，
 * 直接扫文件里的 JSON 片段 —— provider 配置是以 JSON 块形式存的。
 */
function scanProviders() {
  if (!fsSync.existsSync(DB)) {
    throw new Error('找不到 cc-switch 库: ' + DB);
  }
  const s = fsSync.readFileSync(DB).toString('latin1');
  const out = [];

  // 抓所有 {...} 片段里同时含 base_url 和 api key 的 JSON 对象。
  // 这里不追求严格解析整库，只求把 provider 捞出来。
  const KEY_PATTERNS = [
    'DASHSCOPE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'ARK_API_KEY', 'GEMINI_API_KEY', 'api_key', 'apiKey',
  ];

  for (const kp of KEY_PATTERNS) {
    const re = new RegExp('"' + kp + '":"([^"]{8,200})"', 'g');
    let m;
    while ((m = re.exec(s))) {
      const key = m[1];
      // 在 key 附近找 base_url / baseURL
      const win = s.slice(Math.max(0, m.index - 3000), m.index + 3000);
      const bu = win.match(/"(?:base_url|baseURL|baseUrl|url)"\s*:\s*"([^"]{8,200})"/);
      out.push({
        keyName: kp,
        key,
        base: bu ? bu[1] : '',
      });
    }
  }

  // 去重（同一 key 可能被多个字段名引用）
  const seen = new Set();
  return out.filter(p => {
    const k = p.keyName + '|' + p.key;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isAliyun(p) {
  return /dashscope|aliyuncs|bailian/i.test(p.base) ||
         /^DASHSCOPE/i.test(p.keyName);
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const providerId = args.includes('--provider')
    ? args[args.indexOf('--provider') + 1] : '';

  let provs;
  try { provs = scanProviders(); }
  catch (e) { console.error('X ' + e.message); process.exit(1); }

  if (!provs.length) {
    console.error('X cc-switch 库里没扫到任何 provider key。');
    console.error('  可能是版本改存储结构了，或 provider 名不同。');
    process.exit(1);
  }

  console.log('在 cc-switch 里找到 ' + provs.length + ' 个 key：');
  provs.forEach((p, i) => {
    console.log('  [' + i + '] ' + p.keyName + '  ' + mask(p.key) +
      '  base=' + (p.base || '(未标注)') +
      (isAliyun(p) ? '  ← 阿里云' : ''));
  });

  if (listOnly) return;

  const aliyun = provs.filter(isAliyun);
  let pick;
  if (providerId) {
    const idx = Number(providerId);
    if (Number.isInteger(idx) && provs[idx]) pick = provs[idx];
  }
  if (!pick) pick = aliyun[0] || provs[0];

  console.log('');
  console.log('选用: ' + pick.keyName + ' ' + mask(pick.key));

  const base = isAliyun(pick) ? ALIYUN_BASE : (pick.base || '');
  if (!base) {
    console.error('X 这个 provider 没有可用的 base_url，无法确定端点。');
    process.exit(1);
  }

  // 模型：阿里云给一个便宜够用的默认，别的端点让用户自己填
  const model = isAliyun(pick) ? 'qwen-plus' : 'deepseek-chat';

  const env =
    '# 本文件含密钥，已在 .gitignore 中，不要提交\n' +
    '# 由 scripts/import-key.mjs 从 cc-switch 导入 ' +
    new Date().toISOString().slice(0, 10) + '\n' +
    'LLM_API_KEY=' + pick.key + '\n' +
    'LLM_BASE_URL=' + base + '\n' +
    'LLM_MODEL=' + model + '\n' +
    '# 百炼上看图要单独指定视觉模型，取消注释即可启用图片抽取\n' +
    '# LLM_VISION_MODEL=qwen-vl-max\n';

  await fs.writeFile(OUT, env, 'utf8');

  console.log('');
  console.log('已写入 .env.local（明文只写进这个文件，未打印到终端）');
  console.log('  LLM_BASE_URL = ' + base);
  console.log('  LLM_MODEL    = ' + model);
  console.log('');
  console.log('下一步：重启服务  npm start，然后 /api/health 应显示 llm:"configured"');
  console.log('测真模型：npm run test:real');
}

main().catch(e => {
  console.error('X 失败:', e.message);
  process.exit(1);
});
