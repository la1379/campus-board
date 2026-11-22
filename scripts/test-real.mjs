/**
 * 真模型测试：拿真公告喂真模型，验证抽取质量。
 *
 * 和 test-intake.mjs 的分工：
 *   test-intake.mjs  用假模型，验证「脏输出能被洗干净」（代码逻辑对不对）
 *   本脚本           用真模型，验证「模型读得准不准」（提取质量好不好）
 *
 * 两者都要跑。假模型过了不代表真模型能用 —— 模型可能把"供应计划工程师"
 * 读成"供应链管理"，代码洗不掉这种错。
 *
 * 用法：
 *   node scripts/test-real.mjs            # 需要先配好 .env.local 并 npm start
 *   node scripts/test-real.mjs --port 7794
 *
 * 退出码 0 = 全绿（但「质量」类检查是启发式，看输出自己判断）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : '7788';
const BOARD = 'http://127.0.0.1:' + PORT;

const fails = [];
const checks = [];

function check(name, cond, detail = '') {
  checks.push([name, !!cond, detail]);
  if (!cond) fails.push(name);
}

// 三条真实风格的公告。取自真实校招公告的写法，不是编的干净数据。
const CASES = [
  {
    name: '邮箱投递 + 中文截止日',
    text: `杭州华锐精密机械有限公司2027届校园招聘

一、招聘岗位
1. 采购专员（3人）：负责原材料采购、供应商开发与交期跟催，要求工业工程、
   物流管理、机械类相关专业，本科及以上学历。
2. 生产计划工程师（2人）：负责生产排程与物料齐套分析，工业工程专业优先。

二、工作地点：杭州萧山、湖州德清

三、薪资待遇：本科首年综合 10-13 万，五险一金，提供宿舍。

四、应聘方式
请将简历投递至 hr@huarui-precision.com，邮件主题格式为
"应聘岗位+姓名+学校+专业"。简历投递截止时间为 2026年12月20日。

五、其他
笔试安排在投递后一周内，CET-4 及以上。`,
    expect: {
      company: /华锐|精密/,
      hasEmail: 'hr@huarui-precision.com',
      deadline: '2026-12-20',
      positionsMin: 2,
      majorsMin: 1,
      citiesMin: 1,
    },
  },
  {
    name: '公众号投递 + 招满即止',
    text: `【校招】宁波东方电缆股份有限公司2027届校园招聘正式启动！

招聘岗位：供应链管理培训生、物流专员、采购工程师

专业要求：物流管理、物流工程、工业工程、供应链管理等相关专业，
2027届全日制本科及以上学历。

工作城市：宁波北仑

投递方式：关注微信公众号「东方电缆招聘」，点击菜单栏
「加入我们」-「校园招聘」选择岗位投递。名额有限，招满即止。

福利：免费班车、餐补、年度体检、员工公寓。`,
    expect: {
      company: /东方电缆|宁波/,
      channelType: 'wechat',
      deadlineKind: 'rolling',
      positionsMin: 2,
      citiesMin: 1,
    },
  },
  {
    name: '网申链接 + 多城市',
    text: `江苏恒瑞医药 2027 校园招聘

恒瑞医药面向 2027 届毕业生开放以下岗位：

· 供应链专员（工作地：连云港、上海、成都）
· 采购管理培训生（工作地：连云港）
· 仓储物流工程师（工作地：连云港、苏州）

任职要求：工业工程、物流管理、药学、化学、机械等相关专业，
2027 年毕业的本科及以上学历应届生。

网申地址：https://campus.hengrui.com/apply
网申截止：2026年11月30日 24:00

注：每人最多投递 2 个岗位，通过初筛后一周内安排线上笔试。`,
    expect: {
      company: /恒瑞/,
      channelType: 'link',
      deadline: '2026-11-30',
      positionsMin: 3,
      citiesMin: 2,
      hasUrl: /hengrui/,
    },
  },
];

async function main() {
  // 1. 服务必须活着且配好了 key
  let health;
  try {
    health = await (await fetch(BOARD + '/api/health')).json();
  } catch (e) {
    console.error('X 连不上 ' + BOARD + '。先 npm start');
    return 2;
  }

  console.log('');
  console.log('  模型    : ' + health.model);
  console.log('  端点    : ' + (health.base || '?'));
  console.log('  视觉    : ' + (health.vision || '未配置（只能用文字）'));
  console.log('');

  if (health.llm !== 'configured') {
    console.error('X 服务未配置 API key（llm=' + health.llm + '）');
    console.error('  先跑 node scripts/import-key.mjs，然后重启 npm start');
    return 2;
  }

  const results = [];

  for (const c of CASES) {
    console.log('  --- ' + c.name + ' ---');
    const t0 = Date.now();
    let body;
    try {
      const r = await fetch(BOARD + '/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: c.text, source: '真模型测试' }),
      });
      body = await r.json();
    } catch (e) {
      check(c.name + ' 请求成功', false, e.message);
      continue;
    }
    const ms = Date.now() - t0;
    if (!body.ok) {
      check(c.name + ' 抽取成功', false, body.error || '未返回 record');
      continue;
    }
    const r = body.record || {};
    const e = c.expect;

    console.log('    耗时 ' + ms + 'ms');
    console.log('    公司 : ' + r.company);
    console.log('    岗位 : ' + (r.positions || []).join(' / '));
    console.log('    专业 : ' + (r.majors || []).join(' / '));
    console.log('    城市 : ' + (r.cities || []).join(' / '));
    console.log('    截止 : ' + r.deadline + '  (' + r.deadline_raw + ')');
    console.log('    渠道 : ' + r.channel_type + ' ' +
      (r.channel_email || r.channel_url || r.channel_steps || '(空)').slice(0, 50));
    if (Object.keys(body.confidence || {}).length) {
      console.log('    警告 : ' + JSON.stringify(body.confidence));
    }

    if (e.company) check(c.name + ': 公司名对', e.company.test(r.company || ''), r.company);
    if (e.hasEmail) check(c.name + ': 抽到邮箱', r.channel_email === e.hasEmail, r.channel_email);
    if (e.deadline) check(c.name + ': 截止日正确', r.deadline === e.deadline, String(r.deadline));
    if (e.channelType) check(c.name + ': 渠道类型 ' + e.channelType,
      r.channel_type === e.channelType, r.channel_type);
    if (e.deadlineKind) check(c.name + ': 招满即止',
      body.record.deadline === null && /招满|尽快/.test(r.deadline_raw || ''),
      r.deadline_raw);
    if (e.positionsMin) check(c.name + ': 岗位数 ≥ ' + e.positionsMin,
      (r.positions || []).length >= e.positionsMin,
      (r.positions || []).length + ' 个');
    if (e.majorsMin) check(c.name + ': 专业数 ≥ ' + e.majorsMin,
      (r.majors || []).length >= e.majorsMin,
      (r.majors || []).length + ' 个');
    if (e.citiesMin) check(c.name + ': 城市数 ≥ ' + e.citiesMin,
      (r.cities || []).length >= e.citiesMin,
      (r.cities || []).length + ' 个');
    if (e.hasUrl) check(c.name + ': 抽到网申链接',
      e.hasUrl.test(r.channel_url || ''), r.channel_url);

    results.push({ case: c.name, ms, ok: true });
    console.log('');
  }

  console.log('');
  for (const [name, ok, detail] of checks) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
      ((!ok && detail) ? '  <- ' + detail : ''));
  }
  console.log('');

  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log('总耗时 ' + total + 'ms，平均 ' +
    Math.round(total / Math.max(1, results.length)) + 'ms/条');
  console.log('');
  console.log('提醒：这些断言只是「有没有抽到」，不等于「抽得对」。');
  console.log('      上面打印的实际值要自己扫一眼，尤其岗位名和专业。');
  console.log('');

  if (fails.length) {
    console.log(`RESULT: FAIL (${fails.length}/${checks.length})`);
    return 1;
  }
  console.log(`RESULT: PASS (${checks.length}/${checks.length})`);
  return 0;
}

main()
  .then(c => process.exit(c))
  .catch(e => {
    console.error('X 测试异常:', e.message);
    process.exit(2);
  });
