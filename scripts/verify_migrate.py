# -*- coding: utf-8 -*-
"""
阶段0 回归断言：验证迁移结果的正确性。
不过就往下走会污染后面所有环节，所以先立断言。

用法：python -I scripts/verify_migrate.py
退出码 0 = 全绿
"""
import json
import os
import sys
from collections import Counter
from datetime import date

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS = os.path.join(BASE, "data", "jobs.json")

fails = []
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    if not cond:
        fails.append(f"{name}  {detail}")


def main():
    if not os.path.exists(JOBS):
        print("FAIL: data/jobs.json 不存在，先跑 scripts/migrate.py")
        return 1

    d = json.load(open(JOBS, encoding="utf-8"))
    jobs = d["jobs"]

    # 1. 取样成功（先确认读到了东西，再断言内容 —— 验证纪律第 4 条）
    check("jobs 非空", len(jobs) > 0, f"len={len(jobs)}")
    if not jobs:
        return report()

    # 2. 旧表 98 条「迁移产物」必须还在。
    #    不能断言「总数 == 98」—— 后来合并进来的采集数据会让总数变，
    #    那是正常增长，不是迁移出错。验「迁移产物还在」，不验「总数不变」。
    manual = [j for j in jobs if j.get("_src") == "manual"]
    check("旧表 98 条迁移产物都还在", len(manual) == 98, f"实际 {len(manual)}")
    check("迁移产物 id 仍是 j-0001..j-0098",
          sorted(j["id"] for j in manual) == ["j-%04d" % i for i in range(1, 99)],
          f"实际 {sorted(j['id'] for j in manual)[:5]}…")

    # 3. 每条必填字段齐全（含投递渠道四件套）。
    #    采集数据也不例外 —— 缺字段会让前端读到 undefined，静默出错。
    required = ["id", "company", "title", "cities", "deadline", "deadline_kind",
                "starred", "source", "created",
                "channel_type", "channel_email", "channel_url", "channel_steps",
                "positions", "majors", "work_content"]
    bad = [j.get("id") for j in jobs if any(k not in j for k in required)]
    check("所有记录必填字段齐全", not bad, f"缺字段: {bad[:5]} (共{len(bad)})")

    # 4. id 唯一
    ids = [j["id"] for j in jobs]
    check("id 唯一", len(set(ids)) == len(ids))

    # 5. deadline_kind 只能是三种
    kinds = Counter(j["deadline_kind"] for j in jobs)
    check("deadline_kind 取值合法",
          set(kinds) <= {"date", "rolling", "unknown"}, str(dict(kinds)))

    # 6. 一致性：kind==date <=> deadline 有值
    inconsistent = [j["id"] for j in jobs
                    if (j["deadline_kind"] == "date") != bool(j["deadline"])]
    check("date 类型必有日期", not inconsistent, f"{inconsistent[:5]}")

    # 7. 日期格式合法
    import re
    badfmt = [j["deadline"] for j in jobs if j["deadline"]
              and not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", j["deadline"])]
    check("日期格式 YYYY-MM-DD", not badfmt, f"{badfmt[:5]}")

    # 8. 日期边界合理（2026-09 ~ 2027-12）
    out_range = [j["deadline"] for j in jobs if j["deadline"]
                 and not ("2026-09-01" <= j["deadline"] <= "2027-12-31")]
    check("日期在合理区间", not out_range, f"{out_range[:5]}")

    # 9. 城市非空（已按表名推断杭州）
    no_city = [j["id"] for j in jobs if not j["cities"]]
    check("每条都有城市", not no_city, f"{no_city[:5]}")

    # 9b. 投递渠道类型白名单
    CH = {"email", "link", "wechat", "site", "unknown"}
    bad_ch = [j["id"] + ":" + str(j["channel_type"])
              for j in jobs if j["channel_type"] not in CH]
    check("channel_type 合法", not bad_ch, f"{bad_ch[:5]}")

    # 9c. 邮箱格式合法（抽错了会白投）
    bad_mail = [j["channel_email"] for j in jobs if j["channel_email"]
                and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}", j["channel_email"])]
    check("邮箱格式合法", not bad_mail, f"{bad_mail[:5]}")

    # 9d. 声称 email 类型就必须真有邮箱
    lie = [j["id"] for j in jobs
           if j["channel_type"] == "email" and not j["channel_email"]]
    check("email 类型必有邮箱地址", not lie, f"{lie[:5]}")

    # 10. 回归基准：具体真值样例逐项比对
    #     安吉物流 10月19日截止（记忆里的硬时间锚点）
    angie = [j for j in jobs if "安吉" in j["company"]]
    check("真值: 安吉物流 deadline=2026-10-19",
          angie and angie[0]["deadline"] == "2026-10-19",
          str(angie[0]["deadline"] if angie else "未找到"))
    #     菜鸟 10.5 截止（曾被批次规则误吞，是本轮修的 bug）
    cainiao = [j for j in jobs if "菜鸟" in j["company"]]
    check("真值: 菜鸟 deadline=2026-10-05",
          cainiao and cainiao[0]["deadline"] == "2026-10-05",
          str(cainiao[0]["deadline"] if cainiao else "未找到"))
    #     物产中大 2027-04-30
    wz = [j for j in jobs if "物产中大集团" in j["company"]]
    check("真值: 物产中大 deadline=2027-04-30",
          wz and wz[0]["deadline"] == "2027-04-30",
          str(wz[0]["deadline"] if wz else "未找到"))
    #     ★ 标记：旧表里 19 个「供应链对口」的星必须还在
    #     注意：不能断言总数 == 19 —— 用户可以在界面上点新增的星，
    #     那是运行时可变状态，绑死会导致假失败。验「原有那 19 个还在」才对。
    old_starred = [j for j in jobs
                   if j["starred"] and j["created"] == "2026-10-15"]
    check("真值: 旧表 19 个星都还在", len(old_starred) >= 19,
          f"实际 {len(old_starred)} 个")

    # 11. 不存 status（存了就会随时间说谎）
    check("不存 status 字段", all("status" not in j for j in jobs))

    # 12. 无分隔行漏进来
    junk = [j["company"] for j in jobs if j["company"].startswith("——")]
    check("无分隔行污染", not junk, f"{junk[:3]}")

    # 13. 幂等键唯一：同一 (_src, _srcId) 只能出现一次。
    #     这是合并逻辑的命门 —— 重复了说明 collect --merge 会越跑越多。
    keys = [(j.get("_src"), j.get("_srcId")) for j in jobs
            if j.get("_srcId") not in (None, "")]
    dup_keys = [k for k, n in Counter(keys).items() if n > 1]
    check("采集幂等键 (_src,_srcId) 无重复", not dup_keys, str(dup_keys[:3]))

    # 14. id 全库唯一（含采集插入的新 id）
    all_ids = [j["id"] for j in jobs]
    check("全库 id 唯一", len(set(all_ids)) == len(all_ids))

    return report()


def report():
    print()
    for name, ok, detail in checks:
        print(("  PASS  " if ok else "  FAIL  ") + name + (("  <- " + detail) if detail and not ok else ""))
    print()
    if fails:
        print(f"RESULT: FAIL ({len(fails)}/{len(checks)})")
        return 1
    print(f"RESULT: PASS ({len(checks)}/{len(checks)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
