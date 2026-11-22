# -*- coding: utf-8 -*-
"""
阶段0：把 xhs-tmp/make_xlsx3.py 里硬编码的岗位数据，迁移成 data/jobs.json

安全说明：用 ast.literal_eval 解析字面量，**不执行**源文件里的任何代码，
因此不需要装 openpyxl，也不会跑到原脚本末尾的 wb.save()。

设计要点（2026-11-21）：
  · 不存 status。只存事实：deadline(ISO) + deadline_kind(date/rolling/unknown)。
    过期与否由前端按当天日期现算 —— 否则文件放一年就开始说谎。
  · 原表没写城市的记录，按表标题「杭州秋招清单」推断为杭州，
    但打上 city_defaulted=True，让用户看得见这是推断不是核实。

用法：python migrate.py
"""
import ast
import json
import os
import re
from collections import Counter
from datetime import date

SRC = r"C:\Users\21952\xhs-tmp\make_xlsx3.py"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "data", "jobs.json")
SEED = os.path.join(BASE, "data", "seed.json")

SNAPSHOT = date(2026, 10, 15)   # 旧表整理日
SNAP_YEAR = 2026                # 无年份的日期按此年推

CITY_WORDS = [
    "杭州", "上海", "北京", "深圳", "广州", "南京", "苏州", "宁波", "温州",
    "无锡", "绍兴", "嘉兴", "台州", "金华", "常州", "合肥", "武汉", "成都",
    "重庆", "西安", "天津", "青岛", "厦门", "福州", "南昌", "长沙", "郑州",
    "乐清", "新昌", "横店", "义乌", "湖州", "衢州", "丽水", "舟山",
]


# ---------- 源码解析 ----------

def extract_rows(path):
    """从 py 源码里把 `rows = [...]` / `rows += [...]` 的字面量取出来，不执行代码。"""
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    rows = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AugAssign):
            tgt, op = node.target, node.op
            if isinstance(tgt, ast.Name) and tgt.id == "rows" and isinstance(op, ast.Add):
                v = _lit(node.value)
                if v:
                    rows.extend(v)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == "rows":
                    v = _lit(node.value)
                    if v:
                        rows.extend(v)
    return rows


def _lit(node):
    try:
        v = ast.literal_eval(node)
        return v if isinstance(v, list) else None
    except (ValueError, SyntaxError):
        return None


# ---------- 字段清洗 ----------

def _mk(y, mo, d):
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


# 顺序很重要：先找真日期，再退回定性描述。
# 反例（已修）：'秋招批次10.5截止' 曾被 '批次\d' 规则抢先判成 unknown。
PATTERNS = [
    # 2027年4月30日
    (re.compile(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"), "ymd"),
    # 10.5截止 / 10-5 截止
    (re.compile(r"(\d{1,2})\s*[.\-]\s*(\d{1,2})\s*日?\s*截止"), "md"),
    # 10月19日 / 11月9日
    (re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日"), "md"),
]


def parse_deadline(raw):
    """自由文本 -> (iso_date|None, kind)。kind ∈ date / rolling / unknown。"""
    s = (raw or "").strip()
    if not s:
        return None, "unknown"

    for pat, kind in PATTERNS:
        m = pat.search(s)
        if not m:
            continue
        if kind == "ymd":
            iso = _mk(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        else:
            iso = _mk(SNAP_YEAR, int(m.group(1)), int(m.group(2)))
        if iso:
            return iso, "date"
        # 日期非法（如 2月30日）当作没解析出来，继续往下走

    if "招满即止" in s or "尽快投" in s:
        return None, "rolling"
    if "进行中" in s:
        return None, "rolling"
    # 官网为准 / 9月已发布 / 9-10月发布 / —
    return None, "unknown"


def parse_cities(*texts):
    blob = " ".join(t for t in texts if t)
    return [c for c in CITY_WORDS if c in blob]


def clean_company(raw):
    s = (raw or "").strip()
    starred = s.startswith("★")
    s = s.lstrip("★").strip()
    return re.sub(r"\s+", " ", s), starred


def clean_apply(raw):
    """投递方式 -> (channel_type, email, url, steps)

    旧表这一列是自由文本，实际出现过三种：
      "「上汽安吉物流HR」公众号 / recruit@anji-logistics.com"
      "campus.wzgroup.cn"
      "阿里校招官网 / campus-talent.alibaba.com"
    尽量把能直接用的东西拆出来。
    """
    s = (raw or "").strip()
    if s in ("—", "-", ""):
        return "unknown", "", "", ""

    email = ""
    m = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", s)
    if m:
        email = m.group(0)

    url = ""
    m = re.search(r"([a-z0-9][a-z0-9.-]*\.(?:com|cn|net|org)[a-z0-9/._-]*)", s, re.I)
    if m:
        url = "https://" + m.group(1)

    if email:
        ctype = "email"
    elif url:
        ctype = "link"
    elif "公众号" in s:
        ctype = "wechat"
    elif "官网" in s:
        ctype = "site"
    else:
        ctype = "unknown"

    steps = re.sub(r"\s*\n\s*", " / ", s).strip()
    return ctype, email, url, steps


# ---------- 主流程 ----------

def main():
    rows = extract_rows(SRC)
    jobs = []
    inferred_city = 0

    for r in rows:
        if not isinstance(r, list) or len(r) < 6:
            continue
        company_raw, title, dl_raw, note, apply_raw, source = (str(x) for x in r[:6])

        if company_raw.startswith("——") or not company_raw.strip():
            continue  # 分隔行

        company, starred = clean_company(company_raw)
        iso, kind = parse_deadline(dl_raw)
        ch_type, ch_email, ch_url, ch_steps = clean_apply(apply_raw)
        cities = parse_cities(title, note, company_raw)

        # 原表是全表"杭州秋招清单"，没写城市的按杭州处理，但标记为推断
        city_defaulted = False
        if not cities:
            cities = ["杭州"]
            city_defaulted = True
            inferred_city += 1

        # 旧表没有拆岗位/专业/做什么，先把 title 原样放进 title，
        # positions/majors/work_content 留空 —— 这些靠录入器的 LLM 补，
        # 不要在这里用规则瞎猜（猜错会误导投递）。
        jobs.append({
            "id": "j-%04d" % (len(jobs) + 1),
            "company": company,
            "title": title.strip(),
            "batch": "27届秋招",
            "positions": [],
            "majors": [],
            "work_content": "",
            "cities": cities,
            "city_defaulted": city_defaulted,
            "deadline": iso,
            "deadline_kind": kind,
            "deadline_raw": dl_raw.strip(),
            # 投递渠道四件套
            "channel_type": ch_type,
            "channel_email": ch_email,
            "channel_url": ch_url,
            "channel_steps": ch_steps,
            "industry": "",
            "note": note.strip(),
            "url": "",
            "starred": starred,
            "source": source.strip(),
            "source_url": "",
            "created": SNAPSHOT.isoformat(),
            "updated": date.today().isoformat(),
        })

    data = {
        "version": 2,
        "updated": date.today().isoformat(),
        "origin": "迁移自 xhs-tmp/make_xlsx3.py（2026-10-15 快照）",
        "jobs": jobs,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    txt = json.dumps(data, ensure_ascii=False, indent=2)
    for p in (OUT, SEED):
        open(p, "w", encoding="utf-8", newline="\n").write(txt)

    today = date.today().isoformat()
    expired = sum(1 for j in jobs if j["deadline_kind"] == "date" and j["deadline"] < today)
    upcoming = sum(1 for j in jobs if j["deadline_kind"] == "date" and j["deadline"] >= today)
    kinds = Counter(j["deadline_kind"] for j in jobs)

    # 只打 ASCII，避开 Windows 控制台 GBK 乱码
    print("jobs            :", len(jobs))
    print("deadline_kind   :", dict(kinds))
    print("expired (<=today):", expired)
    print("upcoming        :", upcoming)
    print("rolling         :", kinds["rolling"])
    print("unknown         :", kinds["unknown"])
    print("starred         :", sum(1 for j in jobs if j["starred"]))
    print("city defaulted  :", inferred_city)
    print("has email       :", sum(1 for j in jobs if j["channel_email"]))
    print("has url         :", sum(1 for j in jobs if j["channel_url"]))
    print("has steps       :", sum(1 for j in jobs if j["channel_steps"]))
    print("written         : data/jobs.json + data/seed.json")


if __name__ == "__main__":
    main()
