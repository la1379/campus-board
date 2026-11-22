/**
 * 把「浏览器读到的页面文字」推进入库管道。
 *
 * 为什么需要这个脚本：
 *   看板的数据源要么是公开 API（京东/腾讯），要么是人工录入。
 *   小红书/公众号这类没有公开 API、也不该爬接口的，正当做法是
 *   「浏览器打开页面 → 读屏幕上已显示的内容」。
 *   但读下来是一大段文字，直接贴进 /intake.html 也可以 —— 这个脚本是
 *   给它加一条命令行通道，方便批量、方便接 Playwright。
 *
 * 它不做爬取，只做「把已经拿到的文字送去抽取」。
 *
 * 三种用法：
 *
 * 1) 从文件读（Playwright 读完存成 txt 再喂）
 *    node scripts/ingest-text.mjs --file page.txt --mode list --source "小红书@xxx"
 *
 * 2) 从 stdin 读（管道）
 *    cat page.txt | node scripts/ingest-text.mjs --mode list
 *
 * 3) 直接传字符串
 *    node scripts/ingest-text.mjs --text "国信证券 base杭州 招满即止"
 *
 * 加 --save 才会真的落库；不加默认只抽取并打印，让你先看清楚。
 */
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const getArg = k => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : '';
};

const PORT = getArg('--port') || process.env.BOARD_PORT || '7788';
const BOARD = 'http://127.0.0.1:' + PORT;
const MODE = getArg('--mode') || 'list';          // list | single
const SOURCE = getArg('--source') || '';
const SOURCE_URL = getArg('--url') || '';
const SAVE = args.includes('--save');
const FILE = getArg('--file');
const INLINE = getArg('--text');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let text = INLINE;
  if (!text && FILE) {
    text = await fs.readFile(FILE, 'utf8');
  }
  if (!text && !process.stdin.isTTY) {
    text = await readStdin();
  }
  if (!text || !text.trim()) {
    console.error('X 没拿到文字。用 --file / --text / stdin 三种方式之一喂进来。');
    process.exit(1);
  }

  // 清一下浏览器复制常见的噪声：连续空行、零宽字符、行尾空格
  text = text
    .replace(/​|﻿/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  console.log('  mode   : ' + MODE);
  console.log('  长度   : ' + text.length + ' 字符');
  console.log('  来源   : ' + (SOURCE || '(未填)'));
  console.log('');

  let res, data;
  try {
    res = await fetch(BOARD + '/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: MODE, source: SOURCE, source_url: SOURCE_URL }),
    });
    data = await res.json();
  } catch (e) {
    console.error('X 连不上 ' + BOARD + '。先 npm start');
    process.exit(2);
  }

  if (!data.ok) {
    console.error('X 抽取失败: ' + (data.error || '未知'));
    if (data._raw) console.error('  原始: ' + String(data._raw).slice(0, 300));
    process.exit(1);
  }

  const items = MODE === 'list' ? (data.items || []) : [data.record];
  console.log('  抽取到 ' + items.length + ' 条' +
    (data.from === 'rule' ? '（规则解析，未调模型）' : '（模型抽取）'));
  console.log('');

  // 打印成表格方便肉眼核对
  const pad = (s, n) => {
    s = String(s == null ? '' : s);
    let w = 0;
    for (const ch of s) w += /[一-龥]/.test(ch) ? 2 : 1;
    return s + ' '.repeat(Math.max(0, n - w));
  };
  console.log('  ' + pad('#', 4) + pad('公司', 24) + pad('城市', 12) +
    pad('截止', 13) + pad('类型', 9) + '原文');
  console.log('  ' + '-'.repeat(78));
  items.forEach((r, i) => {
    console.log('  ' + pad(i + 1, 4) + pad(r.company, 24) +
      pad((r.cities || []).join(','), 12) +
      pad(r.deadline || '—', 13) +
      pad(r.deadline_kind || '—', 9) +
      (r.deadline_raw || ''));
  });

  const warns = Object.entries(data.confidence || {});
  if (warns.length) {
    console.log('');
    console.log('  警告:');
    warns.forEach(([k, v]) => console.log('    ' + k + ': ' + JSON.stringify(v)));
  }

  if (!SAVE) {
    console.log('');
    console.log('  （未落库。确认无误后加 --save 再跑一次）');
    return;
  }

  const records = items.filter(r => r && r.company);
  if (!records.length) {
    console.error('X 没有任何一条有公司名，不保存。');
    process.exit(1);
  }
  const sres = await fetch(BOARD + '/api/jobs/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const sd = await sres.json();
  if (!sd.ok) {
    console.error('X 保存失败: ' + (sd.error || '未知'));
    process.exit(1);
  }
  console.log('');
  console.log('  已保存 ' + sd.saved + ' 条，库中共 ' + sd.total + ' 条');
  if (sd.skipped && sd.skipped.length) {
    console.log('  跳过 ' + sd.skipped.length + ' 条（无公司名）');
  }
}

main().catch(e => {
  console.error('X 失败:', e.message);
  process.exit(1);
});
