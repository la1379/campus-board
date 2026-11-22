/* 校招看板 —— 零依赖前端
 *
 * 核心设计：**状态不存，现算。**
 * 数据里只有 deadline(ISO) 和 deadline_kind。是否过期、还剩几天，
 * 每次渲染时拿当天日期算。这样数据文件放一年也不会说谎。
 */
(function () {
  'use strict';

  // ---------- 工具 ----------

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function daysBetween(aISO, bISO) {
    // 用 UTC 中午相减，避开夏令时/时区把天数算歪
    var a = Date.parse(aISO + 'T12:00:00Z');
    var b = Date.parse(bISO + 'T12:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  // ---------- 状态现算 ----------

  var TODAY = todayISO();

  /**
   * @returns {{code:string, label:string, cls:string, left:number|null}}
   *   code: active | soon | expired | rolling | unknown
   */
  function stateOf(job) {
    if (job.deadline_kind === 'date' && job.deadline) {
      var left = daysBetween(TODAY, job.deadline);
      if (left === null) return { code: 'unknown', label: '日期异常', cls: '', left: null };
      if (left < 0) return { code: 'expired', label: job.deadline, cls: 'past', left: left };
      if (left <= 7) return { code: 'soon', label: job.deadline, cls: 'soon', left: left };
      return { code: 'active', label: job.deadline, cls: '', left: left };
    }
    if (job.deadline_kind === 'rolling') {
      return { code: 'rolling', label: '招满即止', cls: 'roll', left: null };
    }
    return { code: 'unknown', label: job.deadline_raw || '截止未明', cls: 'roll', left: null };
  }

  function leftText(st) {
    if (st.left === null) return '';
    if (st.left < 0) return '已过 ' + Math.abs(st.left) + ' 天';
    if (st.left === 0) return '今天截止';
    return '还剩 ' + st.left + ' 天';
  }

  // ---------- 数据 ----------

  var DATA = null;      // {jobs:[], updated, origin}
  var VIEW = 'list';    // list | table

  function loadData() {
    // 1) 发布版：数据已内联进 index.html（构建时注入 window.__JOBS__）
    if (window.__JOBS__) {
      DATA = window.__JOBS__;
      return Promise.resolve(DATA);
    }
    // 2) 本地开发：直接 fetch data/jobs.json
    return fetch('data/jobs.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { DATA = d; return d; })
      .catch(function (e) {
        // 3) 都失败：给一句人话，而不是白屏
        throw new Error('读不到 data/jobs.json（' + e.message +
          '）。本地请用 server.mjs 启动，或直接打开发布版。');
      });
  }

  // ---------- 个人档案 + 匹配度 ----------
  //
  // 匹配度是「判断」，不是「事实」，所以**不入库**。
  // 它只取决于「谁在看」—— 换个人打开，同一条岗位的分数就该不同。
  // 存在 localStorage；发布版还可以用 build 时内联的 window.__PROFILE__ 当默认值。

  var PROFILE = null;
  var PKEY = 'campus-board-profile';

  var DEFAULT_PROFILE = {
    majors: [], cities: [], directions: [], batch: '', education: '',
    _weights: { major: 0.4, city: 0.3, direction: 0.3 },
  };

  function loadProfile() {
    // 1) 用户在本机改过的，优先
    try {
      var s = localStorage.getItem(PKEY);
      if (s) { PROFILE = JSON.parse(s); return Promise.resolve(); }
    } catch (e) { /* localStorage 可能被禁 */ }

    // 2) 发布版内联的默认档案
    if (window.__PROFILE__) { PROFILE = window.__PROFILE__; return Promise.resolve(); }

    // 3) data/profile.json
    return fetch('data/profile.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { PROFILE = p || DEFAULT_PROFILE; })
      .catch(function () { PROFILE = DEFAULT_PROFILE; });
  }

  function uniq(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      var k = String(x).trim();
      if (k && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }

  /**
   * 打分：专业 0.4 / 城市 0.3 / 方向 0.3，三项独立，最多 100。
   * 返回 {score, hits, miss} —— hits 用来解释「为什么是这个分」。
   *
   * 为什么不用模型：可解释性比精确更重要。关键词命中是用户能自己复核的；
   * 模型给个 73 分却说不出理由，反而不能信。
   *
   * 铁律：**没填档案就不该有分数。**
   * 空档案时如果还按「专业不限=满分」「全国招聘=满分」算，
   * 会显示出 30%~40% 的虚假匹配 —— 那些分不是「适合你」，只是「谁都能投」。
   */
  function scoreJob(job) {
    var P = PROFILE || DEFAULT_PROFILE;
    var W = P._weights || DEFAULT_PROFILE._weights;

    // 档案没填的维度直接不计分，也不把它算成「命中」。
    var hasMajor = (P.majors || []).length > 0;
    var hasCity = (P.cities || []).length > 0;
    var hasDir = (P.directions || []).length > 0;

    if (!hasMajor && !hasCity && !hasDir) {
      return { score: 0, hits: [], miss: ['还没填「我的档案」'] };
    }

    var score = 0, hits = [], miss = [];

    // --- 专业 ---
    var majors = job.majors || [];
    var myMajors = P.majors || [];
    if (!hasMajor) {
      miss.push('未设专业');
    } else if (!majors.length) {
      miss.push('未写专业要求');
    } else if (majors.indexOf('不限') >= 0) {
      score += W.major;
      hits.push('专业不限');
    } else {
      var hitM = majors.filter(function (m) {
        return myMajors.some(function (x) { return m.indexOf(x) >= 0 || x.indexOf(m) >= 0; });
      });
      if (hitM.length) {
        score += W.major;
        hits.push('要求「' + hitM.slice(0, 3).join('、') + '」');
      } else {
        miss.push('专业不匹配（要求 ' + majors.slice(0, 3).join('/') + '）');
      }
    }

    // --- 城市 ---
    var cities = job.cities || [];
    var myCities = P.cities || [];
    if (!hasCity) {
      miss.push('未设城市');
    } else if (job.nationwide) {
      score += W.city;
      hits.push('全国招聘');
    } else if (!cities.length) {
      miss.push('城市未明');
    } else if (job.city_overseas_only) {
      miss.push('岗位在海外');
    } else {
      var hitC = cities.filter(function (c) { return myCities.indexOf(c) >= 0; });
      if (hitC.length) {
        score += W.city;
        hits.push('城市 ' + hitC.join('、'));
      } else {
        miss.push('城市不含 ' + myCities.join('/'));
      }
    }

    // --- 方向：岗位名 / 岗位列表 / 做什么 / 类目 里找关键词 ---
    var blob = [job.title]
      .concat(job.positions || [])
      .concat([job.work_content, job.jobCategory, job.jobDirection, job.note])
      .join(' ');
    var dirs = P.directions || [];
    if (!hasDir) {
      miss.push('未设方向');
    } else {
      var hitD = dirs.filter(function (d) { return d && blob.indexOf(d) >= 0; });
      if (hitD.length) {
        // 命中越多给满，命中 1 个给 60%（不因为凑巧撞到一个词就给满分）
        var ratio = Math.min(1, 0.6 + (hitD.length - 1) * 0.2);
        score += W.direction * ratio;
        hits.push('方向「' + hitD.slice(0, 3).join('、') + '」');
      } else {
        miss.push('方向不相关');
      }
    }

    // --- 届数（不加分，但明显不符要标出来）---
    if (P.batch && job.batch) {
      var a = String(P.batch).replace(/[^\d]/g, '');
      var b = String(job.batch).replace(/[^\d]/g, '');
      if (a && b && a !== b) miss.push('批次 ' + job.batch + '（你是 ' + P.batch + '）');
    }

    return {
      score: Math.round(score * 100),
      hits: hits,
      miss: miss,
    };
  }

  var SCORE_CACHE = {};   // id -> {score,hits,miss}；档案变了要清空
  function scoreOf(job) {
    var id = job.id;
    if (!SCORE_CACHE[id]) SCORE_CACHE[id] = scoreJob(job);
    return SCORE_CACHE[id];
  }

  function matchCls(score) {
    if (score >= 80) return 'm-high';
    if (score >= 55) return 'm-mid';
    if (score >= 30) return 'm-low';
    return 'm-none';
  }


  // ---------- 筛选 ----------

  var F = { q: '', city: [], batch: '', state: 'active', sort: 'deadline' };

  function matchQuery(job, q) {
    if (!q) return true;
    var blob = [job.company, job.title, job.note, job.industry,
      (job.cities || []).join(' ')].join(' ').toLowerCase();
    // 空格分隔 = AND，每个词都得命中
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) {
      return blob.indexOf(t) >= 0;
    });
  }

  function applyFilters() {
    var out = (DATA.jobs || []).filter(function (j) {
      if (!matchQuery(j, F.q)) return false;
      // 城市多选 = OR（命中任一所选城市即可）。
      // 岗位常同时挂「杭州 上海 北京」，只选一个城市会漏掉那些「杭州+其他」的。
      if (F.city.length) {
        var cities = j.cities || [];
        var hit = F.city.some(function (c) { return cities.indexOf(c) >= 0; });
        if (!hit) return false;
      }
      if (F.batch && j.batch !== F.batch) return false;

      var st = stateOf(j);
      switch (F.state) {
        case 'active':  // 可投 = 有日期且未过期，或招满即止/未明
          return st.code !== 'expired';
        case 'star':
          return j.starred && st.code !== 'expired';
        case 'closing':
          return st.code === 'soon';
        case 'match':
          // 「能投 + 值得投」：既没过期，匹配度又够
          return st.code !== 'expired' && scoreOf(j).score >= 60;
        case 'expired':
          return st.code === 'expired';
        case 'all':
        default:
          return true;
      }
    });

    out.sort(sorter(F.sort));
    return out;
  }

  var STATE_ORDER = { soon: 0, active: 1, rolling: 2, unknown: 3, expired: 4 };

  function sorter(key) {
    if (key === 'company') {
      return function (a, b) {
        return a.company.localeCompare(b.company, 'zh-Hans-CN');
      };
    }
    if (key === 'created') {
      return function (a, b) {
        return String(b.created).localeCompare(String(a.created)) ||
               a.company.localeCompare(b.company, 'zh-Hans-CN');
      };
    }
    if (key === 'match') {
      // 空档案时按匹配度排等于乱排（全是 0），退回按截止日
      if (profileEmpty()) return sorter('deadline');
      // 先按分数降序；同分时快截止的靠前
      return function (a, b) {
        var d = scoreOf(b).score - scoreOf(a).score;
        if (d) return d;
        var sa = stateOf(a), sb = stateOf(b);
        var oa = STATE_ORDER[sa.code], ob = STATE_ORDER[sb.code];
        if (oa !== ob) return oa - ob;
        return a.company.localeCompare(b.company, 'zh-Hans-CN');
      };
    }
    // deadline：先按状态分层（快截止的在最前），层内按日期升序
    return function (a, b) {
      var sa = stateOf(a), sb = stateOf(b);
      var oa = STATE_ORDER[sa.code], ob = STATE_ORDER[sb.code];
      if (oa !== ob) return oa - ob;
      if (sa.left !== null && sb.left !== null) return sa.left - sb.left;
      return a.company.localeCompare(b.company, 'zh-Hans-CN');
    };
  }

  // ---------- 渲染 ----------

  function renderStats() {
    var jobs = DATA.jobs || [];
    var active = 0, soon = 0, star = 0, match = 0;
    var empty = profileEmpty();
    jobs.forEach(function (j) {
      var st = stateOf(j);
      if (st.code !== 'expired') active++;
      if (st.code === 'soon') soon++;
      if (j.starred && st.code !== 'expired') star++;
      if (!empty && st.code !== 'expired' && scoreOf(j).score >= 60) match++;
    });
    el('statRow').innerHTML =
      stat(active, '当前可投', '') +
      stat(soon, '7 天内截止', soon ? 'hot' : '') +
      // 空档案时这一格换成提示，而不是显示 0
      (empty
        ? stat('?', '点「我的档案」算匹配', 'match')
        : stat(match, '匹配 ≥60%', match ? 'match' : '')) +
      stat(star, '★ 关注', '') +
      stat(jobs.length, '总计', 'done');
  }

  function stat(n, label, cls) {
    return '<div class="stat ' + cls + '"><b>' + n + '</b><span>' +
      esc(label) + '</span></div>';
  }

  var CITY_COUNTS = {};   // 城市 -> 岗位数，多选面板用

  function renderOptions() {
    var cities = {}, batches = {};
    (DATA.jobs || []).forEach(function (j) {
      (j.cities || []).forEach(function (c) { cities[c] = (cities[c] || 0) + 1; });
      if (j.batch) batches[j.batch] = (batches[j.batch] || 0) + 1;
    });
    CITY_COUNTS = cities;

    renderCityList();
    fillSelect('batch', '全部批次', batches, F.batch);
  }

  // 城市多选面板：按岗位数降序，带搜索框
  function renderCityList() {
    var q = (el('cityQ') && el('cityQ').value || '').trim().toLowerCase();
    var keys = Object.keys(CITY_COUNTS)
      .filter(function (k) { return !q || k.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) {
        return CITY_COUNTS[b] - CITY_COUNTS[a] || a.localeCompare(b, 'zh-Hans-CN');
      });

    var html = keys.map(function (k) {
      var on = F.city.indexOf(k) >= 0;
      return '<label class="multi-item' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-city="' + esc(k) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + esc(k) + '</span>' +
        '<em>' + CITY_COUNTS[k] + '</em></label>';
    }).join('');
    el('cityList').innerHTML = html || '<p class="multi-empty">没有匹配的城市</p>';

    Array.prototype.forEach.call(
      el('cityList').querySelectorAll('[data-city]'),
      function (cb) {
        cb.addEventListener('change', function () {
          var c = cb.getAttribute('data-city');
          if (cb.checked) {
            if (F.city.indexOf(c) < 0) F.city.push(c);
          } else {
            F.city = F.city.filter(function (x) { return x !== c; });
          }
          cb.closest('.multi-item').classList.toggle('on', cb.checked);
          syncCityLabel();
          render();
        });
      }
    );
    syncCityLabel();
  }

  function syncCityLabel() {
    var lab = el('cityLabel');
    if (!lab) return;
    if (!F.city.length) {
      lab.textContent = '全部城市';
      el('cityBtn').classList.remove('on');
    } else if (F.city.length <= 2) {
      lab.textContent = F.city.join('、');
      el('cityBtn').classList.add('on');
    } else {
      lab.textContent = F.city.slice(0, 2).join('、') + ' 等 ' + F.city.length + ' 城';
      el('cityBtn').classList.add('on');
    }
  }

  function fillSelect(id, allLabel, map, cur) {
    var keys = Object.keys(map).sort(function (a, b) {
      return map[b] - map[a] || a.localeCompare(b, 'zh-Hans-CN');
    });
    var html = '<option value="">' + allLabel + '</option>';
    keys.forEach(function (k) {
      html += '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') +
        '>' + esc(k) + ' (' + map[k] + ')</option>';
    });
    el(id).innerHTML = html;
  }

  function renderChips() {
    var parts = [];
    if (F.q) parts.push(chip('q', '搜索: ' + F.q));
    F.city.forEach(function (c) { parts.push(chip('city:' + c, c)); });
    if (F.batch) parts.push(chip('batch', F.batch));
    el('chips').innerHTML = parts.join('');
    Array.prototype.forEach.call(el('chips').querySelectorAll('.chip'), function (c) {
      c.addEventListener('click', function () {
        var k = c.getAttribute('data-k');
        if (k.indexOf('city:') === 0) {
          var city = k.slice(5);
          F.city = F.city.filter(function (x) { return x !== city; });
          renderCityList();
        } else {
          F[k] = '';
        }
        syncControls();
        render();
      });
    });
  }

  function chip(k, label) {
    return '<span class="chip" data-k="' + k + '">' + esc(label) +
      '<span class="x">×</span></span>';
  }

  function render() {
    var jobs = applyFilters();
    renderChips();

    var empty = el('empty');
    empty.classList.toggle('hidden', jobs.length > 0);

    var list = el('list'), tableWrap = el('tableWrap');
    var isTable = VIEW === 'table';
    list.classList.toggle('hidden', isTable);
    tableWrap.classList.toggle('hidden', !isTable);
    el('viewBtn').textContent = isTable ? '表格' : '列表';
    el('viewBtn').classList.toggle('on', isTable);

    if (isTable) {
      tableWrap.innerHTML = renderTable(jobs);
      bindCopyButtons(tableWrap);
    } else {
      list.innerHTML = jobs.map(renderCard).join('');
      bindCopyButtons(list);
      bindStarButtons(list);
    }

    el('footCount').textContent = '显示 ' + jobs.length + ' / ' +
      (DATA.jobs || []).length + ' 条';
  }

  function citiesCell(job) {
    var cities = job.cities || [];
    if (!cities.length) return '';

    // 全国岗（京东物流运营挂 40+ 城市）是事实不是脏数据，
    // 但全铺开会把整张卡片淹掉。折前 6 个 + 「等 N 地」。
    var MAX = 6;
    var shown = cities.slice(0, MAX);
    var html = shown.map(function (c) {
      return '<span class="tag' + (job.city_defaulted ? ' infer' : '') + '">' +
        esc(c) + '</span>';
    }).join('');
    if (cities.length > MAX) {
      html += '<span class="tag more" title="' + esc(cities.join(' ')) + '">等 ' +
        cities.length + ' 地</span>';
    }
    if (job.city_overseas_only) {
      html += '<span class="tag more" title="' +
        esc((job.overseas || []).join(' / ')) + '">海外岗</span>';
    }
    return html;
  }

  // ---------- 投递渠道渲染 ----------
  // 校招大量走邮箱投递，所以「能一键复制」是最高频动作。

  var CH_LABEL = {
    email: '邮箱', link: '网申链接', wechat: '公众号',
    site: '官网', unknown: '',
  };

  function channelCell(job) {
    var t = job.channel_type || 'unknown';

    // 邮箱：做成可点击复制的按钮
    if (job.channel_email) {
      return '<button class="ch ch-copy" data-copy="' + esc(job.channel_email) +
        '" title="点击复制">✉ ' + esc(job.channel_email) + '</button>';
    }
    if (job.channel_url) {
      return '<a class="ch" href="' + esc(job.channel_url) +
        '" target="_blank" rel="noopener">↗ ' + (CH_LABEL[t] || '链接') + '</a>';
    }
    if (job.channel_steps) {
      return '<span class="ch ch-text" title="' + esc(job.channel_steps) + '">' +
        esc(t === 'wechat' ? '公众号' : '投递路径') + '</span>';
    }
    return '';
  }

  function bindCopyButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-copy]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var v = b.getAttribute('data-copy');
        var done = function () {
          var old = b.textContent;
          b.textContent = '✓ 已复制';
          b.classList.add('copied');
          setTimeout(function () {
            b.textContent = old;
            b.classList.remove('copied');
          }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(done).catch(function () { fallbackCopy(v, done); });
        } else {
          fallbackCopy(v, done);
        }
      });
    });
  }

  // ---------- 星标：本地服务写盘，静态站写 localStorage ----------
  //
  // 发布版是纯静态 HTML，没有 /api/jobs。这时星标只能存在浏览器里。
  // 不去「假装成功再回滚」—— 那会让用户点完星一秒后又变回去，以为坏了。

  var STATIC = !!window.__STATIC__;      // publish.mjs 构建时注入
  var SKEY = 'campus-board-stars';

  function loadLocalStars() {
    try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; }
  }

  function applyLocalStars() {
    if (!STATIC) return;
    var m = loadLocalStars();
    (DATA.jobs || []).forEach(function (j) {
      if (Object.prototype.hasOwnProperty.call(m, j.id)) j.starred = !!m[j.id];
    });
  }

  function saveLocalStar(id, val) {
    var m = loadLocalStars();
    m[id] = !!val;
    try { localStorage.setItem(SKEY, JSON.stringify(m)); } catch (e) { /* 静默 */ }
  }

  // 点星星切换关注。本地服务写进数据文件；静态站写 localStorage。
  // 刷新后都还在。
  function bindStarButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-star]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var id = b.getAttribute('data-star');
        var job = (DATA.jobs || []).find(function (j) { return j.id === id; });
        if (!job) return;

        var next = !job.starred;
        job.starred = next;
        b.classList.toggle('on', next);
        b.textContent = next ? '★' : '☆';
        b.title = next ? '取消关注' : '标记关注';
        var card = b.closest('.job');
        if (card) card.classList.toggle('is-star', next);
        renderStats();

        if (STATIC) { saveLocalStar(id, next); return; }

        fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, record: job }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { job.starred = !next; renderStats(); render(); }
        }).catch(function () {
          job.starred = !next;
          renderStats();
          render();
        });
      });
    });
  }

  function fallbackCopy(v, done) {
    var ta = document.createElement('textarea');
    ta.value = v;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 静默 */ }
    document.body.removeChild(ta);
  }

  function profileEmpty() {
    var P = PROFILE || DEFAULT_PROFILE;
    return !(P.majors || []).length && !(P.cities || []).length &&
           !(P.directions || []).length;
  }

  function matchChip(job) {
    // 空档案不显示分数：那个 0% 没有信息量，还会让人以为「全都不匹配」。
    if (profileEmpty()) return '';
    var m = scoreOf(job);
    if (!m.score) return '';
    var title = m.hits.length ? m.hits.join(' ｜ ') : '没命中任何条件';
    if (m.miss.length) title += '\n不匹配：' + m.miss.join(' ｜ ');
    return '<span class="match ' + matchCls(m.score) + '" title="' + esc(title) + '">' +
      m.score + '%</span>';
  }

  function renderCard(job) {
    var st = stateOf(job);
    var cls = 'job' + (job.starred ? ' is-star' : '') +
              (st.code === 'expired' ? ' is-expired' : '');
    var link = job.url || job.channel_url || '';
    var linkHtml = link
      ? '<a class="link" href="' + esc(link) + '" target="_blank" rel="noopener">公告 ↗</a>'
      : '';

    var tags = citiesCell(job);
    if (job.batch) tags += '<span class="tag">' + esc(job.batch) + '</span>';
    if (job.industry) tags += '<span class="tag">' + esc(job.industry) + '</span>';
    if (job.bgs && job.bgs.length) {
      tags += '<span class="tag" title="事业群">' + esc(job.bgs.join('/')) + '</span>';
    }

    // 岗位 / 专业 / 做什么 —— 用户要的"快速查阅"
    var detail = '';
    if (job.positions && job.positions.length) {
      detail += '<div class="job-line"><b>岗</b>' +
        job.positions.map(function (p) { return '<span class="tag pos">' + esc(p) + '</span>'; }).join('') +
        '</div>';
    }
    if (job.majors && job.majors.length) {
      detail += '<div class="job-line"><b>专</b>' +
        job.majors.map(function (m) { return '<span class="tag major">' + esc(m) + '</span>'; }).join('') +
        '</div>';
    }
    if (job.work_content) {
      detail += '<div class="job-line"><b>做</b>' + esc(job.work_content) + '</div>';
    }

    var ch = channelCell(job);

    var dlLabel = st.code === 'rolling' || st.code === 'unknown'
      ? st.label
      : shortDate(st.label);

    return '<article class="' + cls + '" data-id="' + esc(job.id) + '">' +
      '<div class="job-main">' +
        '<div class="job-company">' +
          '<button class="star-btn' + (job.starred ? ' on' : '') +
            '" data-star="' + esc(job.id) + '" title="' +
            (job.starred ? '取消关注' : '标记关注') + '">' +
            (job.starred ? '★' : '☆') + '</button>' +
          matchChip(job) +
          esc(job.company) +
        '</div>' +
        (job.title ? '<div class="job-title">' + esc(job.title) + '</div>' : '') +
        detail +
        (job.note ? '<div class="job-note">' + esc(job.note) + '</div>' : '') +
        '<div class="job-meta">' + tags + '</div>' +
      '</div>' +
      '<div class="job-side">' +
        '<span class="dl ' + st.cls + '">' + esc(dlLabel) + '</span>' +
        (st.left !== null ? '<span class="dl left">' + esc(leftText(st)) + '</span>' : '') +
        ch +
        linkHtml +
      '</div>' +
    '</article>';
  }

  function shortDate(iso) {
    if (!iso || iso.length < 10) return iso || '';
    return iso.slice(5).replace('-', '/');  // 2026-10-19 -> 10/19
  }

  function renderTable(jobs) {
    var head = '<table><thead><tr>' +
      '<th>公司</th><th>匹配</th><th>岗位</th><th>专业</th><th>做</th><th>城市</th>' +
      '<th>截止</th><th>剩余</th><th>投递渠道</th><th>来源</th>' +
      '</tr></thead><tbody>';

    var body = jobs.map(function (job) {
      var st = stateOf(job);
      var cls = (job.starred ? 'is-star ' : '') +
                (st.code === 'expired' ? 'is-expired' : '');
      var link = job.url || job.channel_url || '';
      var company = esc(job.company) +
        (link ? ' <a class="link" href="' + esc(link) +
          '" target="_blank" rel="noopener">↗</a>' : '');

      var ch = job.channel_email
        ? '<button class="ch ch-copy" data-copy="' + esc(job.channel_email) +
          '">✉ ' + esc(job.channel_email) + '</button>'
        : (job.channel_url
            ? '<a class="ch" href="' + esc(job.channel_url) + '" target="_blank" rel="noopener">↗ 链接</a>'
            : (job.channel_steps
                ? '<span class="ch ch-text" title="' + esc(job.channel_steps) + '">' +
                  esc(CH_LABEL[job.channel_type] || '路径') + '</span>'
                : ''));

      return '<tr class="' + cls.trim() + '">' +
        '<td class="nowrap">' + (job.starred ? '★ ' : '') + company + '</td>' +
        '<td class="nowrap">' + matchChip(job) + '</td>' +
        '<td>' + esc((job.positions || []).join('、') || job.title) + '</td>' +
        '<td>' + esc((job.majors || []).join('、')) + '</td>' +
        '<td>' + esc(job.work_content) + '</td>' +
        '<td class="nowrap">' + esc((job.cities || []).join(' ')) + '</td>' +
        '<td class="nowrap">' + esc(job.deadline || job.deadline_raw || '') + '</td>' +
        '<td class="nowrap">' + esc(leftText(st)) + '</td>' +
        '<td class="nowrap">' + ch + '</td>' +
        '<td class="nowrap">' + esc(job.source) + '</td>' +
      '</tr>';
    }).join('');

    return head + body + '</tbody></table>';
  }

  // ---------- 交互 ----------

  // 从 URL 读初始筛选，方便分享链接（如 /?state=star&city=杭州）
  function readUrlFilters() {
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { return; }
    ['q', 'batch', 'state', 'sort'].forEach(function (k) {
      var v = p.get(k);
      if (v) F[k] = v;
    });
    var city = p.get('city');
    if (city) {
      F.city = city.split(/[,，]+/).map(function (s) { return s.trim(); })
        .filter(Boolean);
    }
  }

  function syncControls() {
    el('q').value = F.q;
    el('batch').value = F.batch;
    // URL 可能给了下拉框里没有的值，那就退回默认，避免显示空白
    if (el('state').querySelector('option[value="' + F.state + '"]')) {
      el('state').value = F.state;
    } else {
      F.state = 'active';
      el('state').value = 'active';
    }
    if (el('sort').querySelector('option[value="' + F.sort + '"]')) {
      el('sort').value = F.sort;
    } else {
      F.sort = 'deadline';
      el('sort').value = 'deadline';
    }
    syncCityLabel();
  }

  function bind() {
    var qTimer;
    el('q').addEventListener('input', function (e) {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () {
        F.q = e.target.value.trim();
        render();
      }, 150);
    });

    ['batch', 'state', 'sort'].forEach(function (id) {
      el(id).addEventListener('change', function (e) {
        F[id] = e.target.value;
        render();
      });
    });

    // 城市多选面板：点外面关闭
    var panel = el('cityPanel');
    el('cityBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        el('cityQ').value = '';
        renderCityList();
        el('cityQ').focus();
      }
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      panel.classList.add('hidden');
    });
    el('cityQ').addEventListener('input', renderCityList);
    el('cityClear').addEventListener('click', function () {
      F.city = [];
      renderCityList();
      render();
    });
    el('cityAll').addEventListener('click', function () {
      // 只选「当前搜索框里可见的」，方便「搜华东 → 全选」
      var q = el('cityQ').value.trim().toLowerCase();
      Object.keys(CITY_COUNTS).forEach(function (c) {
        if (q && c.toLowerCase().indexOf(q) < 0) return;
        if (F.city.indexOf(c) < 0) F.city.push(c);
      });
      renderCityList();
      render();
    });

    el('viewBtn').addEventListener('click', function () {
      VIEW = VIEW === 'list' ? 'table' : 'list';
      render();
    });
  }

  // ---------- 个人档案面板 ----------

  function fillProfileForm() {
    var P = PROFILE || DEFAULT_PROFILE;
    el('p-majors').value = (P.majors || []).join(', ');
    el('p-cities').value = (P.cities || []).join(', ');
    el('p-dirs').value = (P.directions || []).join(', ');
    el('p-batch').value = P.batch || '';
  }

  function readProfileForm() {
    var split = function (v) {
      return uniq(String(v).split(/[,，、\s]+/).filter(Boolean));
    };
    return {
      majors: split(el('p-majors').value),
      cities: split(el('p-cities').value),
      directions: split(el('p-dirs').value),
      batch: el('p-batch').value.trim(),
      education: (PROFILE && PROFILE.education) || '',
      _weights: (PROFILE && PROFILE._weights) || DEFAULT_PROFILE._weights,
    };
  }

  function bindProfile() {
    var panel = el('profilePanel');
    el('profileBtn').addEventListener('click', function () {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) fillProfileForm();
    });

    el('p-save').addEventListener('click', function () {
      PROFILE = readProfileForm();
      SCORE_CACHE = {};                      // 档案变了，缓存全部作废
      try { localStorage.setItem(PKEY, JSON.stringify(PROFILE)); } catch (e) { /* 静默 */ }
      el('p-msg').textContent = '已保存，分数重算';
      setTimeout(function () { el('p-msg').textContent = ''; }, 2500);
      renderStats();
      renderOptions();
      render();
    });

    el('p-reset').addEventListener('click', function () {
      try { localStorage.removeItem(PKEY); } catch (e) { /* 静默 */ }
      PROFILE = null;
      SCORE_CACHE = {};
      loadProfile().then(function () {
        fillProfileForm();
        renderStats();
        render();
        el('p-msg').textContent = '已恢复默认档案';
        setTimeout(function () { el('p-msg').textContent = ''; }, 2500);
      });
    });
  }

  // 首次打开（没填过档案）给一句引导。只提示一次，填完就不再出现。
  function maybePromptProfile() {
    if (!profileEmpty()) return;
    try {
      if (localStorage.getItem('campus-board-prompted') === '1') return;
      localStorage.setItem('campus-board-prompted', '1');
    } catch (e) { /* 禁用 localStorage 时就直接提示 */ }

    var bar = document.createElement('div');
    bar.className = 'onboard';
    bar.innerHTML =
      '<span>填一下你的专业、城市、方向，这张表就能按「跟你有多像」排序。</span>' +
      '<button class="btn on" id="onboardGo">填一下</button>' +
      '<button class="btn" id="onboardX" title="关闭">×</button>';
    var main = document.querySelector('main.wrap');
    if (main) main.insertBefore(bar, main.firstChild);
    // 顶部工具栏是 sticky 的，会盖住页面最上方的一块内容。
    // 引导条正好在最上面，得主动滚一下才能看全。
    requestAnimationFrame(function () {
      var top = bar.getBoundingClientRect().top + window.scrollY - 130;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });

    var open = function () {
      bar.remove();
      if (el('profilePanel').classList.contains('hidden')) el('profileBtn').click();
    };
    el('onboardGo').addEventListener('click', open);
    el('onboardX').addEventListener('click', function () { bar.remove(); });
  }

  // ---------- 启动 ----------

  function boot() {
    loadProfile()
      .then(loadData)
      .then(function (d) {
        applyLocalStars();
        var n = (d.jobs || []).length;
        el('subline').textContent =
          '共 ' + n + ' 条 · 更新于 ' + (d.updated || '—') +
          (STATIC ? ' · 静态版' : '');
        SCORE_CACHE = {};
        readUrlFilters();
        renderOptions();
        renderStats();
        bind();
        bindProfile();
        syncControls();
        render();
        maybePromptProfile();
      })
      .catch(function (e) {
        el('subline').textContent = '数据载入失败';
        el('list').innerHTML =
          '<p class="empty">' + esc(e.message) + '</p>';
        el('list').classList.remove('hidden');
      });
  }

  // 暴露给将来可能的调试
  window.__board = {
    stateOf: stateOf, todayISO: todayISO, daysBetween: daysBetween,
    scoreJob: function (j) { SCORE_CACHE = {}; return scoreJob(j); },
  };

  boot();
})();
