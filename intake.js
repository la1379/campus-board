/* 录入器前端：粘贴公告 → 调 /api/extract → 人工核对 → POST /api/jobs */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var images = [];   // data:image/... 数组

  // ---------- 消息 ----------

  function msg(text, kind) {
    var m = el('msg');
    if (!text) { m.innerHTML = ''; return; }
    m.innerHTML = '<div class="msg ' + (kind || '') + '">' + esc(text) + '</div>';
    if (kind === 'ok') setTimeout(function () { m.innerHTML = ''; }, 4000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 图片 ----------

  function addImage(dataUrl, name) {
    if (images.length >= 6) { msg('最多 6 张图', 'err'); return; }
    images.push(dataUrl);
    renderThumbs();
  }

  function renderThumbs() {
    el('thumbs').innerHTML = images.map(function (src, i) {
      return '<div class="thumb"><img src="' + src + '" alt="">' +
        '<button data-i="' + i + '" title="移除">×</button></div>';
    }).join('');
    Array.prototype.forEach.call(el('thumbs').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        images.splice(Number(b.getAttribute('data-i')), 1);
        renderThumbs();
      });
    });
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!f.type || f.type.indexOf('image/') !== 0) continue;
      var d = await fileToDataUrl(f);
      addImage(d, f.name);
    }
  }

  function bindImageInput() {
    var drop = el('drop');

    drop.addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.multiple = true;
      inp.onchange = function () { handleFiles(inp.files); };
      inp.click();
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    // 全页粘贴截图
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = [];
      for (var i = 0; i < e.clipboardData.items.length; i++) {
        var it = e.clipboardData.items[i];
        if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
          files.push(it.getAsFile());
        }
      }
      if (files.length) { handleFiles(files); }
    });
  }

  // ---------- 抽取 ----------

  function currentMode() {
    var r = document.querySelector('input[name="mode"]:checked');
    return r ? r.value : 'single';
  }

  function syncModeTips() {
    var listMode = currentMode() === 'list';
    var tip = el('listTip');
    if (tip) tip.classList.toggle('hidden', !listMode);
    var ta = el('text');
    if (ta) {
      ta.placeholder = listMode
        ? '把盘点清单粘在这里，一行一家：\n国药集团 base杭州 12月31日截止\n恒瑞医药 base杭州 招满即止'
        : '把招聘公告的文字粘在这里……\n\n也可以只放截图，下面上传图片即可。';
    }
  }

  async function extract() {
    var text = el('text').value.trim();
    if (!text && !images.length) {
      msg('请先贴文字或上传截图', 'err');
      return;
    }

    var mode = currentMode();
    el('go').disabled = true;
    el('go').textContent = '抽取中…';
    msg('');

    try {
      var res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          images: images,
          mode: mode,
          source: el('source').value.trim(),
          source_url: el('sourceUrl').value.trim(),
        }),
      });
      var data = await res.json();

      if (!data.ok) {
        msg('抽取失败：' + (data.error || '未知错误'), 'err');
        if (data._raw) showRaw(data._raw);
        return;
      }
      if (mode === 'list') fillList(data);
      else fillResult(data);
    } catch (e) {
      msg('请求失败：' + e.message, 'err');
    } finally {
      el('go').disabled = false;
      el('go').textContent = '开始抽取';
    }
  }

  // ---------- 清单模式 ----------

  var LIST = [];   // [{on, rec, warn}]

  function fillList(data) {
    LIST = (data.items || []).map(function (rec) {
      return { on: true, rec: rec, warn: {} };
    });
    // 把逐条警告摊到对应行
    var conf = data.confidence || {};
    Object.keys(conf).forEach(function (k) {
      var m = /^#(\d+)\s/.exec(k);
      if (m) {
        var i = Number(m[1]) - 1;
        if (LIST[i]) LIST[i].warn = conf[k];
      }
    });

    el('stepInput').classList.add('hidden');
    el('stepList').classList.remove('hidden');

    var tag = el('listSource');
    if (tag) {
      tag.style.display = '';
      tag.textContent = data.from === 'rule' ? '规则解析 · 未调模型' : '模型抽取';
      tag.className = 'ch-tag' + (data.from === 'rule' ? '' : '');
    }
    renderList();
    if (data._raw) showRaw(data._raw);
    window.scrollTo(0, 0);
    msg('');
  }

  function renderList() {
    var body = el('listBody');
    body.innerHTML = LIST.map(function (it, i) {
      var r = it.rec;
      var warns = Object.keys(it.warn || {}).map(function (k) {
        return it.warn[k];
      }).filter(Boolean);
      return '<tr data-i="' + i + '" class="' + (it.on ? '' : 'off') + '">' +
        '<td class="shrink"><input type="checkbox" data-on="' + i + '"' +
          (it.on ? ' checked' : '') + '></td>' +
        '<td><input type="text" data-f="company" data-i="' + i + '" value="' +
          esc(r.company) + '"></td>' +
        '<td class="shrink" style="min-width:80px"><input type="text" data-f="city" data-i="' + i +
          '" value="' + esc((r.cities || []).join(',')) + '"></td>' +
        '<td class="shrink" style="min-width:110px"><input type="text" data-f="deadline" data-i="' + i +
          '" value="' + esc(r.deadline || '') + '"></td>' +
        '<td class="shrink cell-muted">' + esc(r.deadline_raw || '—') + '</td>' +
        '<td class="cell-warn">' + esc(warns.join('；')) + '</td>' +
      '</tr>';
    }).join('');

    updateListCount();

    // 勾选
    Array.prototype.forEach.call(body.querySelectorAll('[data-on]'), function (cb) {
      cb.addEventListener('change', function () {
        var i = Number(cb.getAttribute('data-on'));
        LIST[i].on = cb.checked;
        cb.closest('tr').classList.toggle('off', !cb.checked);
        updateListCount();
      });
    });

    // 编辑单元格
    Array.prototype.forEach.call(body.querySelectorAll('[data-f]'), function (inp) {
      inp.addEventListener('input', function () {
        var i = Number(inp.getAttribute('data-i'));
        var f = inp.getAttribute('data-f');
        var v = inp.value;
        if (f === 'city') {
          LIST[i].rec.cities = v.split(/[,，、\s]+/).filter(Boolean);
        } else if (f === 'deadline') {
          v = v.trim();
          LIST[i].rec.deadline = /^20\d{2}-\d{2}-\d{2}$/.test(v) ? v : null;
          LIST[i].rec.deadline_kind = LIST[i].rec.deadline
            ? 'date'
            : (/招满|尽快/.test(LIST[i].rec.deadline_raw || '') ? 'rolling' : 'unknown');
        } else {
          LIST[i].rec[f] = v;
        }
        inp.closest('tr').classList.add('dirty');
      });
    });
  }

  function updateListCount() {
    var n = LIST.filter(function (x) { return x.on; }).length;
    var c = el('listCount');
    if (c) c.textContent = '共 ' + LIST.length + ' 条，已勾选 ' + n + ' 条';
    var all = el('chkAll');
    if (all) all.checked = n === LIST.length && LIST.length > 0;
  }

  async function saveList() {
    var picked = LIST.filter(function (x) { return x.on && x.rec.company.trim(); })
      .map(function (x) {
        var r = x.rec;
        return {
          company: r.company.trim(),
          title: r.title || '',
          batch: r.batch || '',
          positions: r.positions || [],
          majors: r.majors || [],
          work_content: r.work_content || '',
          cities: r.cities || [],
          deadline: r.deadline || null,
          deadline_kind: r.deadline ? 'date' : (r.deadline_kind || 'unknown'),
          deadline_raw: r.deadline_raw || '',
          channel_type: r.channel_type || 'unknown',
          channel_email: r.channel_email || '',
          channel_url: r.channel_url || '',
          channel_steps: r.channel_steps || '',
          note: r.note || '',
          source: r.source || el('source').value.trim(),
          source_url: r.source_url || el('sourceUrl').value.trim(),
          url: r.url || '',
        };
      });

    if (!picked.length) { msg('没有勾选任何条目', 'err'); return; }

    el('listSave').disabled = true;
    el('listSave').textContent = '保存中…';
    try {
      var res = await fetch('/api/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: picked }),
      });
      var d = await res.json();
      if (!d.ok) { msg('保存失败：' + (d.error || ''), 'err'); return; }

      var extra = (d.skipped && d.skipped.length)
        ? '，跳过 ' + d.skipped.length + ' 条（无公司名）' : '';
      msg('已保存 ' + d.saved + ' 条' + extra +
        '（共 ' + d.total + ' 条）。正在跳回看板…', 'ok');
      setTimeout(function () { location.href = '/'; }, 1100);
    } catch (e) {
      msg('保存失败：' + e.message, 'err');
    } finally {
      el('listSave').disabled = false;
      el('listSave').textContent = '保存勾选的';
    }
  }

  var CUR = null;

  function fillResult(data) {
    CUR = data;
    var r = data.record || {};
    var c = data.confidence || {};

    el('r-company').value = r.company || '';
    el('r-batch').value = r.batch || '';
    el('r-title').value = r.title || '';
    el('r-positions').value = (r.positions || []).join(', ');
    el('r-majors').value = (r.majors || []).join(', ');
    el('r-work').value = r.work_content || '';
    el('r-cities').value = (r.cities || []).join(', ');
    el('r-deadline').value = r.deadline || '';
    el('r-deadlineRaw').value = r.deadline_raw || '';

    el('r-chType').value = r.channel_type || 'unknown';
    el('r-chEmail').value = r.channel_email || '';
    el('r-chUrl').value = r.channel_url || '';
    el('r-chSteps').value = r.channel_steps || '';
    el('r-note').value = r.note || '';

    // 置信度提示
    el('w-company').textContent = r.company ? '' : '↑ 没抽到，必填';
    el('w-deadline').textContent = c.deadline || '';
    el('w-channel').textContent = c.channel || '';

    toggleEmailField();

    el('stepInput').classList.add('hidden');
    el('stepResult').classList.remove('hidden');
    if (data._raw) showRaw(data._raw);
    window.scrollTo(0, 0);
    msg('');
  }

  function toggleEmailField() {
    var t = el('r-chType').value;
    el('emailWrap').style.display = (t === 'email') ? '' : 'none';
  }

  function showRaw(raw) {
    el('rawBox').classList.remove('hidden');
    el('raw').textContent = raw;
  }

  // ---------- 保存 ----------

  async function save() {
    var company = el('r-company').value.trim();
    if (!company) { msg('公司名称不能为空', 'err'); return; }

    var split = function (sel) {
      return el(sel).value.split(/[,，、\s]+/).map(function (s) { return s.trim(); })
        .filter(Boolean);
    };

    var rec = {
      company: company,
      title: el('r-title').value.trim(),
      batch: el('r-batch').value.trim(),
      positions: split('r-positions'),
      majors: split('r-majors'),
      work_content: el('r-work').value.trim(),
      cities: split('r-cities'),
      deadline: el('r-deadline').value.trim() || null,
      deadline_raw: el('r-deadlineRaw').value.trim(),
      channel_type: el('r-chType').value,
      channel_email: el('r-chEmail').value.trim(),
      channel_url: el('r-chUrl').value.trim(),
      channel_steps: el('r-chSteps').value.trim(),
      note: el('r-note').value.trim(),
      source: (CUR && CUR.record && CUR.record.source) || el('source').value.trim(),
      source_url: (CUR && CUR.record && CUR.record.source_url) || el('sourceUrl').value.trim(),
      url: (CUR && CUR.record && CUR.record.url) || '',
    };

    // deadline 为空但原文有内容 → 归到 rolling/unknown
    if (!rec.deadline) {
      rec.deadline_kind = /招满即止|尽快投|进行中/.test(rec.deadline_raw) ? 'rolling' : 'unknown';
    }

    el('save').disabled = true;
    el('save').textContent = '保存中…';
    try {
      var res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: rec }),
      });
      var d = await res.json();
      if (!d.ok) { msg('保存失败：' + (d.error || ''), 'err'); return; }

      msg('已保存：' + rec.company + '（共 ' + d.total + ' 条）。正在跳回看板…', 'ok');
      setTimeout(function () { location.href = '/'; }, 900);
    } catch (e) {
      msg('保存失败：' + e.message, 'err');
    } finally {
      el('save').disabled = false;
      el('save').textContent = '保存到看板';
    }
  }

  // ---------- 绑定 ----------

  function bind() {
    bindImageInput();
    el('go').addEventListener('click', extract);
    el('clear').addEventListener('click', function () {
      el('text').value = '';
      el('source').value = '';
      el('sourceUrl').value = '';
      images = [];
      renderThumbs();
      msg('');
    });
    el('save').addEventListener('click', save);
    el('back').addEventListener('click', function () {
      el('stepResult').classList.add('hidden');
      el('stepInput').classList.remove('hidden');
      window.scrollTo(0, 0);
    });
    el('r-chType').addEventListener('change', toggleEmailField);

    // 模式切换
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="mode"]'),
      function (r) { r.addEventListener('change', syncModeTips); }
    );
    syncModeTips();

    // 清单模式
    el('chkAll').addEventListener('change', function (e) {
      LIST.forEach(function (x) { x.on = e.target.checked; });
      renderList();
    });
    el('listSave').addEventListener('click', saveList);
    el('listBack').addEventListener('click', function () {
      el('stepList').classList.add('hidden');
      el('stepInput').classList.remove('hidden');
      window.scrollTo(0, 0);
    });
    el('listClear').addEventListener('click', function () {
      LIST = [];
      el('stepList').classList.add('hidden');
      el('stepInput').classList.remove('hidden');
      el('text').value = '';
      msg('');
    });

    // Ctrl+Enter 提交
    el('text').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); extract(); }
    });
  }

  // 健康检查：没配 key 就先说清楚，别等用户贴完才知道
  fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
    if (h.llm === 'missing') {
      msg('服务端未配置 API key，抽取功能不可用。' +
          '请在项目根目录建 .env.local，写入 LLM_API_KEY=你的key，然后重启服务。', 'err');
    } else if (h.llm === 'configured' && !h.vision) {
      // 文本模型抽不了图。提前说明，免得用户传了截图才发现。
      var drop = el('drop');
      if (drop) {
        drop.textContent = '当前模型不支持图片识别，请把公告文字粘贴到上面';
        drop.style.cursor = 'default';
        drop.style.opacity = '0.6';
      }
    }
  }).catch(function () {});

  bind();
})();
