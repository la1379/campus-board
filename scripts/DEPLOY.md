# 部署到 GitHub Pages（一键）

把 `dist/` 推到 `gh-pages` 分支，GitHub Pages 会从那个分支发布。
同学打开 `https://<用户名>.github.io/<仓库名>/` 就能看到，你更新后刷新即生效。

## 一次性准备（只做一次）

### 1. 建仓库

在 https://github.com/new 新建一个仓库，比如叫 `campus-board`。
**设为 Public**（私有仓库的 Pages 要付费）。

或者在终端：

```bash
gh repo create campus-board --public --description "校招看板"
```

### 2. 在本项目初始化 git 并关联

```bash
cd "C:/Users/21952/Desktop/p着玩/bro问我校招看板"
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin git@github.com:la1379/campus-board.git
git push -u origin main
```

### 3. 开启 Pages（从 gh-pages 分支）

```bash
gh api -X POST repos/la1379/campus-board/pages \
  -f "source[branch]=gh-pages" -f "source[path]=/"
```

或者网页操作：仓库 → Settings → Pages → Source 选 `gh-pages` 分支 / `/ (root)`。

## 之后每次更新数据

```bash
npm run deploy
```

它会做：`publish` 生成 dist → 推到 gh-pages 分支 → 打印你的网址。

## 原理（为什么这样能同步）

静态站本身不会「同步」。但 GitHub Pages 是一个**所有人都能访问的公共位置**：

```
你的电脑                      GitHub                     同学的浏览器
   │                             │                             │
   ├─ 改 jobs.json               │                             │
   ├─ npm run deploy ────────────▶ gh-pages 分支更新            │
   │                             │                             │
   │                             │ ◀──── 刷新页面 ──────────────┤
   │                             │ ───── 拿到新 index.html ────▶│
```

你推一次，所有人刷新都是新的。**不需要你在场，也不需要同学做任何事。**

## 注意

- 同学看到的是**只读**的：能筛选、搜索、在自己浏览器打星标，不能录入或改数据。
- 星标存在**各自浏览器的 localStorage**，同学之间不共享，你改数据也不会清掉他们的星标。
- 数据全部内联在 HTML 里，所以**同学打开就能看到全部内容**，不需要接口。
- 更新后一般 30 秒到 1 分钟生效（GitHub Pages 有 CDN 缓存）。
