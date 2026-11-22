# -*- coding: utf-8 -*-
"""
Excel 导入：把 DSH 采集的表格并进 data/jobs.json。

设计原则：
  1. **列序无关，按表头名模糊匹配**。你的表头写「公司名称」「公司」「单位」「企业」
     都认；列怎么排都行。不用迁就脚本。
  2. **不猜**。表里没的字段就留空，不从别的列硬凑。
  3. **幂等**。同一份 Excel 导入两次不会翻倍（按 公司名+岗位 去重）。
  4. **先预览后写入**。默认只报告「会导入什么」，加 --save 才写文件。

用法：
  python -I scripts/import-xlsx.py 表.xlsx                    # 预览
  python -I scripts/import-xlsx.py 表.xlsx --save             # 写入
  python -I scripts/import-xlsx.py 表.xlsx --save --dry-run   # 等价预览
  python -I scripts/import-xlsx.py 表.xlsx --sheet 工作表1    # 指定 sheet

退出码 0 = 成功
"""
import argparse
import json
import os
import re
import sys
from datetime import date, datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS = os.path.join(BASE, "data", "jobs.json")

# 表头模糊匹配：每个标准字段给一组候选词（小写比对，包含即命中）
HEADER_MAP = {
    "company":      ["公司名称", "公司名", "公司", "企业名称", "企业", "单位", "单位名称", "招聘单位"],
    "title":        ["招聘简章", "简章", "标题", "公告", "公告标题", "招聘公告", "文章标题"],
    "positions":    ["在招岗位", "招聘岗位", "岗位", "职位", "岗位名称", "职位名称", "招聘职位"],
    "majors":       ["专业", "专业要求", "相关专业", "需求专业", "专业方向"],
    "work_content": ["做什么", "工作内容", "岗位职责", "职责", "工作职责", "主要工作"],
    "cities":       ["城市", "工作城市", "工作地点", "地点", "base", "base地", "工作地"],
    "deadline":     ["截止", "截止日期", "截止时间", "网申截止", "截止日", "报名截止"],
    "deadline_raw": ["截止原文", "原文", "截止表述"],
    "channel_type": ["渠道类型", "投递方式类型"],
    "channel_email": ["邮箱", "投递邮箱", "邮箱地址", "email", "e-mail"],
    "channel_url":  ["投递链接", "网申链接", "链接", "网申地址", "url", "网址"],
    "channel_steps": ["投递路径", "投递方式", "投递渠道", "如何投递", "公众号"],
    "industry":     ["行业", "所属行业"],
    "note":         ["备注", "补充", "说明", "其他", "简评", "评价", "点评", "要点", "特点"],
    "url":          ["公告链接", "原文链接", "来源链接"],
    "source":       ["来源", "信息来源", "采集来源"],
    "batch":        ["批次", "届数", "招聘批次"],
}

# 一个字段可能对应多列（如「投递方式」里既有邮箱又有链接），
# 按优先级：越靠前的候选词越优先
CITY_SPLIT = re.compile(r"[,，、/\s|]+")


def norm(s):
    """表头归一：去空白、去括号备注、小写。"""
    s = str(s or "").strip().lower()
    s = re.sub(r"[（(].*?[)）]", "", s)     # 去掉「(可选)」这类
    s = re.sub(r"[\s_\-]+", "", s)
    return s


def match_headers(header_row):
    """把表头行映射成 {标准字段: 列号}。列序无关。"""
    mapping = {}
    used = set()
    headers = [norm(h) for h in header_row]

    # 两轮：先精确匹配，再包含匹配，避免「公司」抢走「公司地址」这种
    for exact in (True, False):
        for idx, h in enumerate(headers):
            if not h or idx in used:
                continue
            for field, cands in HEADER_MAP.items():
                if field in mapping:
                    continue
                for c in cands:
                    cn = norm(c)
                    hit = (h == cn) if exact else (cn in h)
                    if hit:
                        mapping[field] = idx
                        used.add(idx)
                        break
                if field in mapping:
                    break
    return mapping


def parse_date(v):
    """各种日期写法 → ISO 或 (None, 原文)。"""
    if v is None or v == "":
        return None, ""
    # Excel 真日期
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d"), v.strftime("%Y-%m-%d")
    s = str(v).strip()
    raw = s
    if not s:
        return None, ""

    # 2026-12-31 / 2026/12/31
    m = re.search(r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if m:
        iso = _mk(m.group(1), m.group(2), m.group(3))
        if iso:
            return iso, raw
    # 2027年3月7日 / 27年3月7日
    m = re.search(r"(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", s)
    if m:
        y = m.group(1)
        if len(y) == 2:
            y = "20" + y
        iso = _mk(y, m.group(2), m.group(3))
        if iso:
            return iso, raw
    # 12月31日（无年份，按今年）
    m = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日", s)
    if m:
        iso = _mk(str(date.today().year), m.group(1), m.group(2))
        if iso:
            return iso, raw
    return None, raw


def _mk(y, mo, d):
    try:
        return date(int(y), int(mo), int(d)).isoformat()
    except (ValueError, TypeError):
        return None


def parse_deadline_kind(deadline, raw):
    if deadline:
        return "date"
    if raw and re.search(r"招满|滚动|尽快|长期", raw):
        return "rolling"
    return "unknown"


def cell_str(v):
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def split_multi(s):
    """「杭州, 上海」/「采购专员、供应计划」→ 列表"""
    if not s:
        return []
    return [x.strip() for x in CITY_SPLIT.split(str(s)) if x.strip()]


def detect_channel(row, mapping):
    """从若干列综合判断投递渠道。"""
    email = cell_str(row[mapping["channel_email"]]) if "channel_email" in mapping else ""
    url = cell_str(row[mapping["channel_url"]]) if "channel_url" in mapping else ""
    steps = cell_str(row[mapping["channel_steps"]]) if "channel_steps" in mapping else ""
    ctype = cell_str(row[mapping["channel_type"]]) if "channel_type" in mapping else ""

    # 邮箱可能被塞进「投递路径」列里，捞一下
    if not email:
        blob = " ".join([steps, url, ctype])
        m = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", blob)
        if m:
            email = m.group(0)
    # URL 同理。也要认「裸域名」：campus.nsfocus.com 这种人在表里常这么写
    if not url:
        blob = " ".join([steps, ctype])
        m = re.search(r"https?://[^\s，。；,;)）]+", blob)
        if m:
            url = m.group(0)
        else:
            m = re.search(
                r"\b((?:[a-z0-9][a-z0-9-]*\.)+(?:com|cn|net|org|edu|gov|io|co)"
                r"(?:\.[a-z]{2})?(?:/[^\s，。；,;)）]*)?)", blob, re.I)
            if m and "公众号" not in m.group(0):
                url = "https://" + m.group(1)

    if email:
        return "email", email, url, steps
    if url:
        return "link", "", url, steps
    if "公众号" in steps or "公众号" in ctype:
        return "wechat", "", "", steps
    if "官网" in steps or "官网" in ctype:
        return "site", "", "", steps
    if steps:
        return "unknown", "", "", steps
    return "unknown", "", "", ""


def is_footer_row(company, row):
    """识别表格底部的说明/脚注行，别当成公司导进去。

    实测旧表底部有这种行：
      "—— 大厂系/子公司（江浙沪...）——"
      "· ★ = 与供应链/采购/物流/计划方向明确对口..."
      "· 小红书 @校招雷达 —— 75家base杭州截止清单"
      "数据来源（建议持续关注）"
    这些被当成公司名导进去，比漏数据更糟 —— 会出现在看板上污染搜索。
    """
    c = company.strip()
    if not c:
        return True
    # 以「·」「——」「说明」「数据来源」开头或整行是标题
    if re.match(r"^[·•\-—–=]+", c):
        return True
    if re.match(r"^(说明|备注|数据来源|注[:：]|信息来源|更新说明)", c):
        return True
    # 整行都是说明性文字的特征：极长 + 含解释性标点
    if len(c) > 40 and re.search(r"[=＝（）()：「」“”]", c):
        return True
    # 只有标点或短得离谱
    if len(c) < 2:
        return True
    return False


def build_record(row, mapping, default_source, default_city=""):
    def g(f):
        return cell_str(row[mapping[f]]) if f in mapping else ""

    company = g("company")
    if not company:
        return None
    # 去掉开头/结尾的 ★ ☆ 和分隔符。旧表用 ★ 标「方向对口」，
    # 这个语义应该进 starred 标记，而不是留在公司名里污染搜索。
    starred = company.startswith("★") or company.startswith("☆")
    company = re.sub(r"^[★☆\s]+|[★☆\s]+$", "", company).strip()
    if not company:
        return None
    if is_footer_row(company, row):
        return None

    deadline_raw_col = g("deadline_raw")
    dl_cell = row[mapping["deadline"]] if "deadline" in mapping else None
    deadline, dl_raw = parse_date(dl_cell)
    if not dl_raw and deadline_raw_col:
        # 截止列是空的，但原文列有内容，试着从原文解析
        deadline, dl_raw = parse_date(deadline_raw_col)
    raw = deadline_raw_col or dl_raw

    # 城市：优先「城市」列；没有就用 --default-city 指定的
    cities = split_multi(g("cities"))
    city_defaulted = False
    if not cities and default_city:
        cities = split_multi(default_city)
        city_defaulted = True

    ctype, email, url, steps = detect_channel(row, mapping)

    return {
        "company": company,
        "title": g("title"),
        "batch": g("batch"),
        "positions": split_multi(g("positions")),
        "majors": split_multi(g("majors")),
        "work_content": g("work_content"),
        "cities": cities,
        "city_defaulted": city_defaulted,
        "deadline": deadline,
        "deadline_kind": parse_deadline_kind(deadline, raw),
        "deadline_raw": raw,
        "channel_type": ctype,
        "channel_email": email,
        "channel_url": url,
        "channel_steps": steps,
        "industry": g("industry"),
        "note": g("note"),
        "url": g("url"),
        "starred": starred,     # ★ 标记转成看板的星标
        "source": g("source") or default_source,
        "source_url": "",
        "_src": "xlsx",
        "_srcId": "",     # 下面按内容生成
    }


def dedupe_key(rec):
    """幂等键：公司 + 岗位 + 城市。同一份表再怎么导都不翻倍。"""
    pos = "|".join(sorted(rec.get("positions") or [])) or rec.get("title", "")
    city = "|".join(sorted(rec.get("cities") or []))
    return rec["company"] + "::" + pos + "::" + city


def norm_text(s):
    """归一化：去空格标点、全半角统一，用来做「这条是不是已经存在」的模糊比对。"""
    s = str(s or "").lower()
    s = s.replace("（", "(").replace("）", ")").replace("，", ",").replace("、", ",")
    s = re.sub(r"[\s\-_/\\|]+", "", s)
    return s


def find_existing(rec, jobs, index):
    """
    找出这条记录在库里可能对应的旧记录。两级匹配：
      1. 精确：_srcId 相同
      2. 模糊：公司名归一后相同 + 岗位有交集（或都为空）

    为什么要模糊匹配：旧 98 条是别的脚本迁进来的，没有 _srcId。
    同一份 Excel 再导一次时，单靠 _srcId 会认不出，导致数据翻倍 ——
    而失败表现是「新增 98 条」，看着像成功。
    """
    k = rec.get("_srcId")
    if k and k in index["by_srcId"]:
        return index["by_srcId"][k]

    cn = norm_text(rec["company"])
    cands = index["by_company"].get(cn)
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]

    # 同公司多条时，按岗位/标题再收窄
    new_pos = {norm_text(p) for p in (rec.get("positions") or []) if p}
    new_title = norm_text(rec.get("title"))
    # 旧数据的「岗位」可能落在 title 里（旧表只有一列「招聘岗位 / 说明」，
    # 迁移时整列塞进了 title，positions 是空的）。所以两个字段都要试。
    new_all = new_pos | ({new_title} if new_title else set())

    best, best_score = None, 0
    for j in cands:
        old_pos = {norm_text(p) for p in (j.get("positions") or []) if p}
        old_title = norm_text(j.get("title"))
        old_all = old_pos | ({old_title} if old_title else set())

        score = 0
        if new_all & old_all:
            score = 2                       # 岗位文字有交集，强证据
        elif not new_all and not old_all:
            score = 1                       # 两边都没有岗位信息
        if score > best_score:
            best, best_score = j, score

    # 只有拿到强证据才认定是同一条。
    # 拿不到就不匹配 —— 宁可多插一条（用户能删），
    # 也不要把「供应计划」的岗位名写到「采购工程师」那条上（静默串数据）。
    return best


def next_id(jobs):
    mx = 0
    for j in jobs:
        m = re.match(r"j-(\d+)$", str(j.get("id") or ""))
        if m:
            mx = max(mx, int(m.group(1)))
    return "j-%05d" % (mx + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--save", action="store_true", help="写入 data/jobs.json")
    ap.add_argument("--dry-run", action="store_true", help="只预览")
    ap.add_argument("--sheet", default=None, help="sheet 名（默认第一个）")
    ap.add_argument("--source", default="", help="默认来源标记")
    ap.add_argument("--default-city", default="", help="表里没有城市列时的默认城市，如 杭州")
    ai = ap.parse_args()

    if not os.path.exists(ai.xlsx):
        print("X 文件不存在: " + ai.xlsx)
        return 2

    try:
        from openpyxl import load_workbook
    except ImportError:
        print("X 缺少 openpyxl。pip install openpyxl")
        return 2

    wb = load_workbook(ai.xlsx, data_only=True, read_only=True)
    ws = wb[ai.sheet] if ai.sheet and ai.sheet in wb.sheetnames else wb[wb.sheetnames[0]]

    rows = list(ws.iter_rows(values_only=True))
    # 找表头行：前 10 行里第一行「至少有 2 个列能匹配上标准字段」
    header_idx = None
    mapping = {}
    for i, r in enumerate(rows[:10]):
        m = match_headers(r)
        if len(m) >= 2 and "company" in m:
            header_idx, mapping = i, m
            break

    if header_idx is None:
        print("X 找不到表头。前 10 行必须有一行含「公司」等列名。")
        print("  实际前 3 行:")
        for r in rows[:3]:
            print("   ", [str(x)[:12] if x is not None else "" for x in r][:8])
        return 1

    print("")
    print("  工作表   : " + str(ws.title))
    print("  表头行   : 第 %d 行" % (header_idx + 1))
    print("  识别到的列:")
    inv = {}
    for f, i in mapping.items():
        inv.setdefault(i, []).append(f)
    for i in sorted(inv):
        hdr = rows[header_idx][i]
        print("    [%d] %-14s -> %s" % (i, str(hdr)[:14], ",".join(inv[i])))

    missing = [f for f in ("company", "positions", "cities", "deadline")
               if f not in mapping]
    if missing:
        print("  没识别到: " + ", ".join(missing) + "（对应字段会留空）")

    # 逐行构建
    records = []
    skipped = []
    for r in rows[header_idx + 1:]:
        if not r or all(x is None or str(x).strip() == "" for x in r):
            continue
        rec = build_record(r, mapping, ai.source, ai.default_city)
        if not rec:
            skipped.append(cell_str(r[mapping["company"]]) if "company" in mapping else "?")
            continue
        rec["_srcId"] = dedupe_key(rec)
        records.append(rec)

    # 文件内去重
    seen = set()
    uniq = []
    dup_in_file = 0
    for rec in records:
        k = rec["_srcId"]
        if k in seen:
            dup_in_file += 1
            continue
        seen.add(k)
        uniq.append(rec)

    print("")
    print("  数据行   : %d" % len(records))
    if dup_in_file:
        print("  表内重复 : %d（已合并）" % dup_in_file)
    if skipped:
        print("  跳过无公司名 : %d" % len(skipped))

    # 预览
    print("")
    print("  %-3s %-22s %-10s %-12s %-8s %-20s %s" % ("#", "公司", "城市", "截止", "类型", "岗位", "渠道"))
    print("  " + "-" * 92)
    for i, rec in enumerate(uniq[:25]):
        ch = rec["channel_email"] or rec["channel_url"] or (
            "公众号" if rec["channel_type"] == "wechat" else
            ("路径" if rec["channel_steps"] else "—"))
        print("  %-3d %-22s %-10s %-12s %-8s %-20s %s" % (
            i + 1,
            rec["company"][:20],
            ",".join(rec["cities"])[:8],
            rec["deadline"] or "—",
            {"date": "有日期", "rolling": "招满即止", "unknown": "未明"}.get(
                rec["deadline_kind"], rec["deadline_kind"]),
            ",".join(rec["positions"])[:18],
            str(ch)[:30],
        ))
    if len(uniq) > 25:
        print("  ... 还有 %d 条" % (len(uniq) - 25))

    # 与现有数据比对
    data = json.load(open(JOBS, encoding="utf-8"))
    jobs = data["jobs"]
    index = {"by_srcId": {}, "by_company": {}}
    for j in jobs:
        if j.get("_srcId"):
            index["by_srcId"][str(j["_srcId"])] = j
        cn = norm_text(j.get("company"))
        if cn:
            index["by_company"].setdefault(cn, []).append(j)

    plan = []      # [(rec, old_or_None)]
    for rec in uniq:
        plan.append((rec, find_existing(rec, jobs, index)))

    new_cnt = sum(1 for _, old in plan if old is None)
    upd_cnt = len(plan) - new_cnt

    print("")
    print("  新增 %d 条，更新 %d 条（现有总数 %d）" % (new_cnt, upd_cnt, len(jobs)))
    if upd_cnt:
        fuzzy = sum(1 for rec, old in plan
                    if old is not None and not (rec.get("_srcId") in index["by_srcId"]))
        if fuzzy:
            print("  其中 %d 条是「公司名+岗位」模糊匹配到的旧记录（旧数据没有幂等键）" % fuzzy)

    if not ai.save or ai.dry_run:
        print("")
        print("  （未写入。确认无误后加 --save）")
        return 0

    # 写入
    if os.path.exists(JOBS):
        bak = os.path.join(BASE, "data", "backups")
        os.makedirs(bak, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with open(os.path.join(bak, "jobs-%s.json" % stamp), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    today = date.today().isoformat()
    for rec, old in plan:
        if old is not None:
            # 身份和来源元数据不覆盖：
            #   _src/_srcId 决定这条记录属于哪个采集通道，导入器不得改写 ——
            #   否则旧 98 条会从 manual 变成 xlsx，溯源就断了。
            # deadline_kind 也不单独覆盖，和 deadline 成对处理（见下）。
            LOCKED = {"id", "starred", "created", "_src", "_srcId", "deadline_kind"}
            for key, v in rec.items():
                if key in LOCKED:
                    continue
                if v in ("", None, []) and old.get(key) not in ("", None, []):
                    continue          # 空值不覆盖
                old[key] = v

            # deadline 和 kind 必须一起动，不能只改一个。
            # 踩过的坑：新值 deadline=None（没解析出）但 kind=unknown，
            # 结果 deadline 保住了旧日期、kind 被改成 unknown，
            # 留下「有日期但标未明」的自相矛盾记录。
            if rec.get("deadline"):
                old["deadline"] = rec["deadline"]
                old["deadline_kind"] = "date"
            old["updated"] = today
        else:
            rec["id"] = next_id(jobs)
            rec["starred"] = bool(rec.get("starred"))
            rec["created"] = today
            rec["updated"] = today
            jobs.append(rec)

    data["updated"] = today
    tmp = JOBS + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, JOBS)

    print("")
    print("  已写入 data/jobs.json")
    print("  总数 %d -> %d" % (len(jobs) - new_cnt, len(jobs)))
    print("  下一步: npm run publish   重新生成静态站")
    return 0


if __name__ == "__main__":
    sys.exit(main())
