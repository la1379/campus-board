# -*- coding: utf-8 -*-
"""
采集器自检：验证一家公司的采集结果是否「干净」。

为什么需要这个（2026-11-21 的真实教训）：
  京东采集第一次跑，控制台显示「有城市 353/353」全绿，
  但实际城市列里混进了"广东省""新疆维吾尔自治区"这种省份名。
  **不报错、不崩、数字还很好看**，只有去看分布才发现 300 个"城市"不合理。

  这条自检把「怎么判断脏」固化成断言，以后每接一家新公司都跑一遍。

用法：python -I scripts/verify_collect.py data/jd-raw.json
"""
import json
import os
import sys
from collections import Counter

MAX_PLAUSIBLE_CITIES = 400      # 全国地级市约 293 个，留余量
MIN_CITY_HIT_RATE = 0.90        # 至少 90% 的岗位要抽到城市
MAX_CITY_PER_JOB = 60           # 单条岗位挂 60 个以上城市，多半是「全国」
UNIQUE_TITLE_MIN = 20           # 岗位名重复度太高说明抓错了层级

fails = []
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    if not cond:
        fails.append(name)


def main():
    if len(sys.argv) < 2:
        print("用法: python -I scripts/verify_collect.py <raw.json>")
        return 2

    p = sys.argv[1]
    if not os.path.exists(p):
        print(f"X 文件不存在: {p}")
        return 2

    d = json.load(open(p, encoding="utf-8"))
    jobs = d.get("jobs") or []

    # 1. 取样成功
    check("有数据", len(jobs) > 0, f"len={len(jobs)}")
    if not jobs:
        return report()

    # 2. 必填字段
    check("全部有岗位名", all(j.get("title") for j in jobs),
          str(sum(1 for j in jobs if not j.get("title"))))

    # 3. 城市命中率
    hit = sum(1 for j in jobs if j.get("cities"))
    rate = hit / len(jobs)
    check(f"城市命中率 >= {MIN_CITY_HIT_RATE:.0%}", rate >= MIN_CITY_HIT_RATE,
          f"{hit}/{len(jobs)} = {rate:.1%}")

    # 4. 城市集合规模合理（这是抓出「省份混进城市」的关键断言）
    allc = Counter()
    for j in jobs:
        for c in j.get("cities") or []:
            allc[c] += 1
    check(f"不同城市数 <= {MAX_PLAUSIBLE_CITIES}", len(allc) <= MAX_PLAUSIBLE_CITIES,
          f"实际 {len(allc)} 个 —— 超过这个数多半是省份/区县混进来了")

    # 5. 不该出现「省」「自治区」结尾的城市
    bad = [c for c in allc if c.endswith(("省", "自治区", "特别行政区"))]
    check("城市列无省份残留", not bad, str(bad[:8]))

    # 6. 城市数很多的岗位必须打了 nationwide 标记
    #    （不是判脏，而是要求「异常必须被显式标注」，否则界面会被撑爆）
    unmarked = [j.get("title") for j in jobs
                if len(j.get("cities") or []) > MAX_CITY_PER_JOB
                and not j.get("nationwide")]
    check("超多城市的岗位已标 nationwide", not unmarked,
          f"{len(unmarked)} 条未标记, 例: {unmarked[:2]}")

    nw = sum(1 for j in jobs if j.get("nationwide"))
    check("nationwide 数量合理", nw <= len(jobs) * 0.1,
          f"{nw}/{len(jobs)} 条被标为全国，比例过高说明判定有问题")

    # 7. 岗位名重复度（重复太多说明抓到的是「计划」而不是「岗位」）
    titles = Counter(j.get("title") for j in jobs)
    uniq_ratio = len(titles) / len(jobs)
    check("岗位名有一定多样性", uniq_ratio > 0.5,
          f"去重后 {len(titles)}/{len(jobs)} = {uniq_ratio:.0%}")

    # 8. 不能有全空的记录
    empty = [i for i, j in enumerate(jobs)
             if not j.get("title") and not j.get("cities")]
    check("无空记录", not empty, str(empty[:5]))

    # 报告统计
    print()
    print("  --- 统计 ---")
    print(f"  岗位总数      : {len(jobs)}")
    print(f"  不同城市      : {len(allc)}")
    print(f"  城市命中      : {hit}/{len(jobs)} ({rate:.0%})")
    print(f"  抽到专业      : {sum(1 for j in jobs if j.get('majors'))}/{len(jobs)}")
    print(f"  抽到届数      : {sum(1 for j in jobs if j.get('batch'))}/{len(jobs)}")
    print(f"  Top5 城市     : " + ", ".join(f"{k}({v})" for k, v in allc.most_common(5)))

    return report()


def report():
    print()
    for name, ok, detail in checks:
        print(("  PASS  " if ok else "  FAIL  ") + name +
              (("  <- " + detail) if detail and not ok else ""))
    print()
    if fails:
        print(f"RESULT: FAIL ({len(fails)}/{len(checks)})")
        return 1
    print(f"RESULT: PASS ({len(checks)}/{len(checks)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
