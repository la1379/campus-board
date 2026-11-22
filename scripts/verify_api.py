# -*- coding: utf-8 -*-
"""
API 层回归断言：星标这类「部分字段更新」不能抹掉其他字段。

为什么需要（2026-11-22 的真实教训）：
  为了让星标操作能写回数据，POST /api/jobs 用字段白名单重建记录。
  结果点一次星，采集来的 majors/cities/_srcId 全没了。
  更糟的是它**不报错**：
    · _srcId 丢了 → 下次 collect --merge 认不出这是同一条 → 数据翻倍
    · majors 丢了 → 匹配度瞬间从 88% 掉到 0%，用户以为岗位变差了

  数据损坏的典型特征是「看起来全都成功」。所以这里把两种调用方式都测一遍。

用法：先 npm start，然后 python -I scripts/verify_api.py
退出码 0 = 全绿
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("BOARD", "http://127.0.0.1:7788")

fails = []
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    if not cond:
        fails.append(name)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def post(path, obj):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(obj).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def pick_target(jobs):
    """挑一条「字段最丰富」的采集记录当靶子，这样丢字段能立刻看出来。"""
    cands = [j for j in jobs if j.get("_src") in ("jd", "qq") and j.get("_srcId") is not None]
    if not cands:
        return None
    return max(cands, key=lambda j: len(j.get("majors") or []) + len(j.get("cities") or []))


def main():
    try:
        data = get("/api/jobs")
    except Exception as e:
        print("X 连不上服务（%s）。先跑 npm start" % e)
        return 2

    jobs = data.get("jobs") or []
    check("能读到数据", len(jobs) > 0, f"len={len(jobs)}")
    t = pick_target(jobs)
    check("找到采集记录当靶子", t is not None)
    if not t:
        return report()

    tid = t["id"]
    before = {
        "majors": list(t.get("majors") or []),
        "cities": list(t.get("cities") or []),
        "src": t.get("_src"),
        "srcId": t.get("_srcId"),
        "starred": bool(t.get("starred")),
    }

    # --- 场景 1：前端点星标的真实载荷（传完整对象）---
    full = dict(t)
    full["starred"] = not before["starred"]
    r = post("/api/jobs", {"id": tid, "record": full})
    rec = r.get("record") or {}
    check("完整对象更新后 majors 不变", rec.get("majors") == before["majors"],
          f"{before['majors']} -> {rec.get('majors')}")
    check("完整对象更新后 _srcId 不变", rec.get("_srcId") == before["srcId"],
          f"{before['srcId']} -> {rec.get('_srcId')}")
    check("完整对象更新后 starred 已切换", rec.get("starred") == full["starred"])

    # --- 场景 2：插件/脚本只传部分字段 ---
    partial = post("/api/jobs", {"id": tid,
                                 "record": {"company": rec.get("company"),
                                            "starred": before["starred"]}})
    prec = partial.get("record") or {}
    check("部分对象更新后 majors 未被清空", prec.get("majors") == before["majors"],
          f"期望 {len(before['majors'])} 项，实际 {len(prec.get('majors') or [])} 项")
    check("部分对象更新后 cities 未被清空", prec.get("cities") == before["cities"],
          f"期望 {len(before['cities'])} 项，实际 {len(prec.get('cities') or [])} 项")
    check("部分对象更新后 _srcId 未被清空", prec.get("_srcId") == before["srcId"])
    check("部分对象更新后 deadline_kind 仍是合法值",
          prec.get("deadline_kind") in ("date", "rolling", "unknown"),
          str(prec.get("deadline_kind")))

    # --- 场景 3：幂等键仍然唯一（星标不应制造重复）---
    after = get("/api/jobs").get("jobs") or []
    keys = [(j.get("_src"), j.get("_srcId")) for j in after if j.get("_srcId") is not None]
    dups = [k for k in set(keys) if keys.count(k) > 1]
    check("星标后无重复幂等键", not dups, str(dups[:3]))
    check("星标后总数未变", len(after) == len(jobs), f"{len(jobs)} -> {len(after)}")

    # 复原：把 starred 改回去，别把测试痕迹留在数据里
    try:
        post("/api/jobs", {"id": tid,
                           "record": {"company": rec.get("company"),
                                      "starred": before["starred"]}})
    except Exception:
        pass

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
