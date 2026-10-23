# E-Hentai 工具集（Tampermonkey 油猴脚本）

两个独立脚本，都用 Tampermonkey 安装，单文件、无外部依赖：

| 脚本 | 作用 |
| --- | --- |
| [`ehentai-downloader.user.js`](ehentai-downloader.user.js) | 在 E-Hentai / ExHentai 页面挂浮动面板，一键把画廊原图打包成 ZIP，或逐图存进指定文件夹；支持多画廊队列、断点续传、失败重试、限速保护 |
| [`ehentai-i18n.user.js`](ehentai-i18n.user.js) | E-Hentai **界面**汉化：本地词库为主（离线可用），可选接 Google / MyMemory 在线翻译兜底未收录文案；只翻译界面，不碰作品标题、标签、图片 |

> 两者互不依赖，可以只装一个；同时装也不冲突（面板分别固定在右下 / 左下角）。

## 一、画廊下载器

### 功能

| 能力 | 说明 |
| --- | --- |
| 单画廊打包 | 自动翻页扫描缩略图 → 逐页解析原图直链（优先 `/fullimg/` 的 Download original，其次 `#img`，再用 `#i4 img` 兜底，并对返回文件做魔数校验）→ 打包成 `001.jpg, 002.jpg …` 的 ZIP |
| 多画廊队列 | 三种入队方式：当前画廊、粘贴链接列表（每行一个）、抓取本页所有画廊链接，或抓取收藏夹（自动跟随 `favorites.php?next=` 翻页） |
| 断点续传 | ① 会话内：暂停/继续、停止后点「开始队列」接着下<br>② 跨会话：已解析的原图直链缓存在 GM 存储里，重开页面不用再请求一遍图片页<br>③ 文件夹模式下按文件名判断，已存在的图直接跳过<br>④ 刷新页面后回到同一画廊点「下载本画廊」即从断点继续，启动时日志会提示「检测到未完成存档」<br>⑤ **队列也持久化**：排队中没跑完的画廊存在 GM 存储里，重开任意 E-Hentai 页面会自动填回队列（只填不跑），点「开始队列」即可接着下 |
| 并行流水线 | 解析图片页与下载图片**同时进行**：后面的页还在解析，前面的页已经开始下载（不再等 849 页全解析完才下载） |
| 实时进度 | 进度条 + 完成页数/百分比 + 已下载字节 + **当前速度（KB/s、MB/s）** + 剩余时间 |
| 失败重试 | 单请求指数退避重试 3 次；单页多个候选地址逐个尝试，全失败会回捞图片页重新解析；失败的页记录在日志里，重跑即可补齐 |
| 限速保护 | 全局请求队列（并发数 + 最小间隔可调），识别「每日浏览上限 / IP 封禁 / 限流」提示页，自动停止或退避；被限流时**自动降速**而不是整批失败 |
| 元数据 | 可选在压缩包/文件夹里附带 `info.txt`（标题、地址、页数、分类、语言、评分、标签） |
| 两种保存方式 | 「打包 ZIP」直接下载；「逐图存文件夹」用 File System Access API 选目录，按画廊名建子文件夹写入 |

### 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Edge / Chrome / Firefox 均可，文件夹模式需要 Chromium 内核）。
2. Tampermonkey 面板 →「添加新脚本」，清空模板。
3. 粘贴 [`ehentai-downloader.user.js`](ehentai-downloader.user.js) 全部内容，`Ctrl+S` 保存。
4. 打开任意 `https://e-hentai.org/g/...`，右下角出现「EH 画廊下载器」面板。

`@match` 已覆盖 `e-hentai.org` 与 `exhentai.org`；`@connect *` 是因为图床域名（`*.hath.network`、`*.ehgt.org` 等）经常轮换，首次运行 Tampermonkey 会弹一次跨域授权，点允许即可。

### 使用

- **下载本画廊**：当前画廊页直接点，按设置的模式输出。
- **加入队列 / 开始队列**：可先攒队列再串行跑，一个画廊结束才开下一个。
- **粘贴链接**：多行粘贴，回车或 `Ctrl+Enter` 入队；链接含 `/g/<gid>/<token>` 即可识别，多余参数忽略。
- **抓取本页画廊 / 抓取收藏夹**：列表页批量入队；收藏夹会跟「下一页」自动翻，最多翻 `设置 → 收藏夹页数` 页（默认 20）。
- **暂停 / 停止**：暂停会让当前批次请求跑完再停；停止立刻中断，队列状态保留，可再点「开始队列」续跑。

### 设置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 保存方式 | 打包 ZIP | ZIP 超过 1.6GB 会提示改用文件夹模式 |
| 并发请求数 | 6 | 同时进行的 HTTP 请求数（解析页 + 图片共用），1–12 |
| 请求间隔(ms) | 250 | 相邻请求最小间隔；被限流时会自动往上调 |
| 附带 info.txt | 开 | 写进压缩包/文件夹 |
| webp 转 jpg | 开 | 只能拿到重采样 webp/avif 时本地转成 JPEG（Windows 照片默认不认 webp） |
| 重扫画廊页 | 关 | 续传时默认复用缓存的页面列表 |

> 从旧版本升级的用户注意：设置存在油猴存储里，旧值（3 并发 / 700ms）会一直沿用，新默认不会自动生效。面板设置里点「速度 → 恢复默认（6 并发 / 250ms）」即可切到新版速度。

### 断点续传的边界

- **ZIP 模式**：ZIP 在内存里拼，刷新页面后已下载的图片字节丢失，续传只表现为不重复解析图片页。
- **文件夹模式**：每张图落盘即完成，重跑同一画廊已存在文件直接跳过，是真正的续传。刷新后需重新授权目录（浏览器安全限制）。

## 二、界面汉化

### 翻译什么

| 翻译 | 不翻译 |
| --- | --- |
| 导航（Front Page / Watched / Favorites / My Home / Popular / Torrents / Toplists / Forums / Wiki / HentaiVerse…） | 作品标题（`#gn`、`.glink`） |
| 画廊信息（Posted: / File Size: / Length: / Language: / Rating: / Favorited: / Average:…） | 标签（`#taglist`、`.gt`、`.gtl`、`.gtw`） |
| 操作按钮（Add to Favorites / Archive Download / Torrent Download (n) / Report Gallery / 上下页 / Reload broken image / Get forum image link / Download original…） | 分类图标文字（`.c1`/`.c2`）、上传者（`#gdn`）、日期原文（`#posted_*`） |
| 计数模式的动态文案（`Showing 1 - 20 of 849 images` → `显示第 1 - 20 张，共 849 张图片`、`N pages`、`N times`、`N comments`、`Score +6`、`Avg`） | 图片地址、纯数字、容量、时间戳 |

### 工作机制

1. 遍历文本节点 → 命中本地词库（约 90 条精确词条 + 14 条正则）就原地替换，原文字符串记进 `records` 数组，随时可「撤销汉化」。
2. **整词导航**：E-Hentai 用 `<span class="nbw">` 把「Front Page」「Favorites」「My Home」拆成两段（渲染大写）。脚本改为整段 `<a>` 匹配，否则会拼出「首页 Page」这种碎片。
3. 未收录的文案只在开启在线引擎时送给翻译服务，结果缓存进 GM 存储（默认 `off`，纯离线）。
4. 用 `MutationObserver` 跟随后续加载（翻页、浮层 = 评论框）增量翻译，跳过自己插入的节点。
5. 页面卸载时自动恢复原文，避免污染浏览器「整页翻译」。

### 安装

同下载器：Tampermonkey 新建脚本 → 粘贴 [`ehentai-i18n.user.js`](ehentai-i18n.user.js) → 保存。面板在左下角，可切换 关闭 / 只汉化界面（默认）/ 界面+在线翻译。

## 三、测试

不依赖浏览器，用抓下来的真实页面做无头验证（需要 `jsdom`，仅测试用）：

```powershell
cd e-hentai-tools
npm install --no-save jsdom      # 只需一次
node test/download-logic.js      # 下载器解析 + ZIP 结构/CRC，55 项
node test/pipeline-logic.js      # 流水线：打桩网络跑完 20 页，9 项
node test/queue-logic.js         # 队列持久化，17 项
# 汉化测试需要真实页面样本，放在 %TEMP%\ehprobe：
#   front.html / gallery.html / i4.html（图片页）
node test/i18n-logic.js          # 汉化匹配 + 撤销，50 项

# 排查「解压不了」：结构 + 每条 CRC
node test/zip-check.js "某个包.zip"
# 修复旧版本写出的 CRC=0 的包（不碰文件内容，只重算头部 CRC）
node tools/fix-zip-crc.js "旧包.zip"
```

ZIP 结构另外用 .NET `ZipFile.OpenRead`、`Expand-Archive` 与 Python `zipfile.testzip()`（会逐条校验 CRC）校验过，AES 无关，STORE 方式可直接解压。

## 四、需要注意的限制

1. **每日图片额度**：非捐赠账号约 2000 张/天，超额返回提示页，脚本报「已达每日浏览上限」并停下。站点规则，不是脚本 bug。
2. **请求速率**：默认 6 并发 / 250ms 间隔已经比旧版快约 5 倍（旧版 3 并发 / 700ms 且解析与下载两轮串行）。再往上调（间隔 <120ms、并发 >10）容易触发临时封禁，脚本虽会自动降速，但别拿账号冒险；感觉被限流就把间隔调回 500ms 以上。
3. **ExHentai 需要登录态**：脚本走 `GM_xmlhttpRequest`，自动带对应域名 Cookie，先在同一浏览器登录（有 `igneous`）再用。
4. **内容警告页 / 年龄确认页**：必须先在浏览器点过确认，否则脚本报错。
5. **原图需要登录**：`/fullimg/...` 未登录会跳到 `bounce_login.php` 返回 HTML（实测 1329 字节），脚本识别后自动退到 `#img` 的 hath.network 地址；那通常是**重采样 webp**，看图软件不认时看起来就是「文件损坏」，所以脚本默认把它转成 JPG 再存（设置里可关）。要拿真原图，先在浏览器登录 E-Hentai / ExHentai。
6. **上限**：单个 ZIP 文件数 ≤ 65535、体积 ≤ 4GB（ZIP32），超出请用文件夹模式。
7. **网络**：如果需要代理才能访问 E-Hentai，请在浏览器/系统侧配好（例如 Clash 的 TUN 或代理模式），脚本本身不处理代理。

## 五、文件结构

```
e-hentai-tools/
├── ehentai-downloader.user.js    # 下载器（全部逻辑，单文件）
├── ehentai-i18n.user.js          # 界面汉化（单文件）
├── README.md
├── archive/
│   └── ehentai-i18n.v1.user.js   # 初版汉化（基于推测文案，已废弃，留档）
└── test/
    ├── download-logic.js         # 下载器解析 / 写包测试
    ├── pipeline-logic.js         # 流水线集成测试（打桩网络，验证并发与解析下载重叠）
    ├── queue-logic.js            # 队列持久化测试
    ├── zip-check.js              # ZIP 体检（结构 + 每条 CRC，排查「解压不了」）
    └── i18n-logic.js             # 汉化无头测试

tools/
└── fix-zip-crc.js                # 修复旧版写出的 CRC=0 的 ZIP（原地重算 CRC 字段）
```

下载器内部链路：`ZipWriter`（STORE 写 ZIP + 自算 CRC32）→ `MemoryZipSink` / `FolderSink` → `Limiter`（并发 + 间隔调度，限流自动降速）→ `fetchText` / `fetchBinary`（重试 + 限流/封禁识别）→ 解析器（`parseGalleryMeta` / `parseThumbLinks` / `parseImagePage` / `sniffImage`）→ `GalleryJob`（扫描 → 流水线：解析图片页与下载图片并行，写入串行）→ 队列 → Shadow DOM 面板。

## 六、排错

| 现象 | 处理 |
| --- | --- |
| 面板不出现 | 确认脚本已启用、URL 是 `e-hentai.org` 或 `exhentai.org`；刷新页面 |
| 提示「需要 Tampermonkey 环境」 | 脚本被当普通 JS 引入了，用油猴安装 |
| 解析阶段大量失败 | 大概率被限流：脚本会自动降速并重排队；仍失败就把间隔调到 600ms 以上，隔几分钟再跑 |
| ZIP 打开报损坏 | 中途点了停止；ZIP 只在全部完成后写出，改用文件夹模式可避免 |
| 解压时报「CRC 错误」/ 解压不了 | 1.4.0 及更早的 bug：webp 转 JPG 后的字节是 `ArrayBuffer`，算 CRC 时长度取成 0，于是所有图片条目的 CRC 都写成 0（图片数据本身是好的）。**1.4.1 已修复，重新下载即可**；已经下好的旧包不用重下，用 `node tools/fix-zip-crc.js "旧包.zip"` 原地重算 CRC（输出到 `... (修复).zip`），或用 7-Zip 的「修复压缩包」 |
| 下载没弹出保存框 | 浏览器拦截了下载，允许本站下载即可 |
| 已登录却提示「未检测到登录 cookie」 | 面板日志会显示登录态检测结果；若确实登录了，确认下载时点的是同站（e-hentai.org）页面，别在 ExHentai 与 E-Hentai 混用（两者 cookie 不通用） |
| 下载的图打不开 / 「不支持此文件格式」 | 旧版按 URL 后缀命名，hath 给 webp 却存成 .jpg。更新脚本后重新下载：未登录会转 JPG，登录后拿真原图 |
| 图片中文乱码 / 译文残留 | 汉化脚本设置里点「撤销汉化」，或刷新页面（卸载时也会自动恢复） |
| 汉化没生效 | 确认设置不是「关闭」；某些浮层文案是服务端懒加载，等页面静止再点「重新汉化」 |