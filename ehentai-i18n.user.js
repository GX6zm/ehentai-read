// ==UserScript==
// @name         E-Hentai 界面汉化
// @namespace    https://local/ehzh
// @version      2.0.0
// @description  把 E-Hentai / ExHentai 的界面文案翻译成中文：内置词库离线可用，可选在线机翻兜底；只翻译界面，不碰标题/标签/评论
// @author       local
// @match        https://e-hentai.org/*
// @match        https://exhentai.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 1. 基础工具
   * ====================================================================== */
  const STORE_PREFIX = 'ehzh.v2.';
  const store = {
    get(key, def) {
      try {
        const v = GM_getValue(STORE_PREFIX + key);
        return v === undefined || v === null ? def : v;
      } catch (e) { return def; }
    },
    set(key, val) { try { GM_setValue(STORE_PREFIX + key, val); } catch (e) { /* ignore */ } },
  };

  const settings = Object.assign({ engine: 'off', auto: false }, store.get('settings', {}) || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  /**
   * 排除区域：这些地方是用户内容或不应改写的结构。
   * 关键点（2026-10 实测 E-Hentai 结构）：
   *  - #gn 画廊标题、#gj 日文标题、#taglist 标签、#gdn 上传者名、#gdt 缩略图
   *  - .nbw 是「禁止换行」的单词包裹 span，会把 Favorites 拆成 "Fav"+"orite"，
   *    所以这里排除，改由 translateAnchors() 按整条 <a> 处理
   *  - .c1/.c2 评论正文
   */
  const EXCLUDE = [
    'script', 'style', 'noscript', 'code', 'pre', 'kbd', 'samp', 'textarea', '[contenteditable]',
    '#ehzh-host',
    '#gn', '#gj', '#taglist', '#gdn', '#gdt',
    '.gt', '.gtl', '.gtw', '.glink', '.glname',
    '.c1', '.c2', '.nbw',
  ];

  function isExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    for (const sel of EXCLUDE) {
      try { if (el.closest(sel)) return true; } catch (e) { /* 老浏览器忽略 */ }
    }
    return false;
  }

  /* =========================================================================
   * 2. 内置词库：全部取自真实页面提取的文案
   * ====================================================================== */
  const DICT = {
    /* --- 站点标题 --- */
    'E-Hentai Galleries - The Free Hentai Doujinshi, Manga and Image Gallery System': 'E-Hentai 画廊 - 免费同人志、漫画与图片画廊系统',
    'E-Hentai Galleries: The Free Hentai Doujinshi, Manga and Image Gallery System': 'E-Hentai 画廊：免费同人志、漫画与图片画廊系统',

    /* --- 顶部导航 / 页脚（#nb） --- */
    'Front Page': '首页',
    'Front': '首页',
    'Watched': '关注',
    'Popular': '热门',
    'Torrents': '种子',
    'Favorites': '收藏夹',
    'My Home': '我的主页',
    'Home': '主页',
    'Uploads': '上传',
    'Toplists': '排行榜',
    'Bounties': '悬赏',
    'News': '新闻',
    'Forums': '论坛',
    'Wiki': 'Wiki',
    'HentaiVerse': 'HentaiVerse',
    'ToS': '服务条款',
    'LoFi': '精简版',
    'Advertise': '广告',

    /* --- 首页检索面板 --- */
    'Show Advanced Options': '显示高级选项',
    'Show File Search': '显示文件搜索',
    'Compact': '紧凑',
    'Extended': '扩展',
    'Minimal': '极简',
    'Minimal+': '极简+',
    'Thumbnail': '缩略图',
    'Title': '标题',
    'Published': '发布日期',
    'Uploader': '上传者',
    'Uploader Comment': '上传者评论',
    'Jump/Seek': '跳转/定位',

    /* --- 分页 --- */
    '<< First': '« 首页',
    'Last >>': '末页 »',
    '< Prev': '‹ 上一页',
    'Next >': '下一页 ›',

    /* --- 画廊页面 --- */
    'Add to Favorites': '加入收藏',
    'Favorited:': '收藏数：',
    'Posted:': '发布时间：',
    'Parent:': '父画廊：',
    'Visible:': '可见性：',
    'Language:': '语言：',
    'File Size:': '文件大小：',
    'Length:': '页数：',
    'Rating:': '评分：',
    'Yes': '是',
    'No': '否',
    'Report Gallery': '举报画廊',
    'Archive Download': '归档下载',
    'Petition to Expunge': '申请删除画廊',
    'Petition to Rename': '申请重命名',
    'Post New Comment': '发表评论',
    'You have to': '你需要先',
    'register': '注册',
    'before you can add comments.': '才能发表评论。',

    /* --- 图片详情页 --- */
    'Show galleries with this image': '查找包含此图的画廊',
    'Get forum image link': '获取论坛图片链接',
    'Reload broken image': '重新加载损坏图片',

    /* --- 分类 --- */
    'Doujinshi': '同人志',
    'Manga': '漫画',
    'Artist CG': '画师CG',
    'Game CG': '游戏CG',
    'Western': '欧美',
    'Non-H': '非H',
    'Cosplay': 'Cosplay',
    'Asian Porn': '亚洲成人',
    'Misc': '杂项',
    'Image Set': '图集',

    /* --- 语言（画廊信息栏里的取值） --- */
    'Japanese': '日语',
    'English': '英语',
    'Chinese': '中文',
    'Korean': '韩语',
    'Spanish': '西班牙语',
    'French': '法语',
    'German': '德语',
    'Russian': '俄语',
    'Thai': '泰语',
    'Vietnamese': '越南语',
    'Italian': '意大利语',
    'Portuguese': '葡萄牙语',
    'Polish': '波兰语',
    'Indonesian': '印尼语',
    'Dutch': '荷兰语',
    'Hungarian': '匈牙利语',
    'Speechless': '无对白',
    'Textless': '无文字',
  };

  const MONTHS = {
    January: '1月', February: '2月', March: '3月', April: '4月', May: '5月', June: '6月',
    July: '7月', August: '8月', September: '9月', October: '10月', November: '11月', December: '12月',
  };

  /** 带变量的文案：只匹配整串，避免误伤标题 */
  const PATTERNS = [
    [/^(\d[\d,]*)\s+pages?$/i, (m) => `${m[1]} 页`],
    [/^(\d[\d,]*)\s+times?$/i, (m) => `${m[1]} 次`],
    [/^Showing (\d+)\s*-\s*(\d+) of (\d+) images$/i, (m) => `显示第 ${m[1]} - ${m[2]} 张，共 ${m[3]} 张图片`],
    [/^Showing (\d+)\s*-\s*(\d+) of (\d+)$/i, (m) => `显示第 ${m[1]} - ${m[2]} 条，共 ${m[3]} 条`],
    [/^Found ([\d,]+) results?\.$/i, (m) => `找到 ${m[1]} 条结果。`],
    [/^Torrent Download \((\d+)\)$/, (m) => `种子下载（${m[1]}）`],
    [/^Average: ([\d.]+)$/i, (m) => `平均：${m[1]}`],
    [/^Score \+(\d+)$/i, (m) => `评分 +${m[1]}`],
    [/^Base \+(\d+)$/i, (m) => `基础 +${m[1]}`],
    [/^Download original (.+)$/i, (m) => `下载原图 ${m[1]}`],
    [/^Posted on (\d{1,2}) ([A-Z][a-z]+) (\d{4}), (\d{2}:\d{2}) by:$/, (m) => {
      const mm = MONTHS[m[2]];
      return mm ? `发表于 ${m[3]}年${mm}${m[1]}日 ${m[4]}，作者：` : null;
    }],
    [/^(\d+) comments?$/i, (m) => `${m[1]} 条评论`],
    [/^(\d+) favorites?$/i, (m) => `${m[1]} 人收藏`],
  ];

  /** 词典优先，其次模式；返回 null 表示不翻译 */
  function lookup(text) {
    if (!text) return null;
    const hit = Object.prototype.hasOwnProperty.call(DICT, text) ? DICT[text] : null;
    if (hit && hit !== text) return hit;
    for (const [re, fn] of PATTERNS) {
      const m = text.match(re);
      if (m) {
        const out = fn(m);
        if (out && out !== text) return out;
      }
    }
    return null;
  }

  /* =========================================================================
   * 3. 只翻界面：挑选可翻译的文本节点
   * ====================================================================== */
  function translatable(text) {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 800) return false;
    if (!/[a-z]/i.test(t)) return false;      // 纯数字/符号/日文汉字不动
    if (CJK.test(t) && !settings.auto) return false;
    return true;
  }

  /* =========================================================================
   * 4. 撤销记录
   * ====================================================================== */
  const records = [];

  function revertAll() {
    while (records.length) {
      const r = records.pop();
      try {
        if (r.kind === 'text') {
          if (r.node && r.node.parentNode) r.node.nodeValue = r.orig;
        } else if (r.kind === 'anchor') {
          r.el.innerHTML = r.orig;
        }
      } catch (e) { /* ignore */ }
    }
  }

  /* =========================================================================
   * 5. 逐节点翻译（词库部分）
   * ====================================================================== */
  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root || document.body || document.documentElement, 4 /* SHOW_TEXT */);
    let n;
    while ((n = walker.nextNode())) {
      const parent = n.parentElement;
      if (!parent) continue;
      if (isExcluded(parent)) continue;
      // 被 .nbw 拆开的导航词（Front Page / Favorites / My Home）交给 translateAnchors 整词处理，
      // 否则会先被逐词翻译，拼出「首页 Page」这种碎片
      const anchor = parent.closest('a');
      if (anchor && anchor.querySelector('.nbw')) continue;
      if (!translatable(n.nodeValue)) continue;
      out.push(n);
    }
    return out;
  }

  /** 真实页面里 Favorites 被拆成 "Fav"+"orite"，必须按整条 <a> 统一翻译 */
  function translateAnchors() {
    let count = 0;
    for (const a of document.querySelectorAll('a')) {
      if (a.closest('#ehzh-host')) continue;
      if (!a.querySelector('.nbw')) continue;      // 只处理被 nbw 拆开的导航词
      if (a.querySelector('img')) continue;
      if (a.dataset.ehzhAnchor === '1') continue;
      const whole = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const zh = lookup(whole);
      if (!zh) continue;
      records.push({ kind: 'anchor', el: a, orig: a.innerHTML });
      a.textContent = zh;
      a.dataset.ehzhAnchor = '1';
      count++;
    }
    return count;
  }

  function translateNodes(nodes) {
    let count = 0;
    for (const n of nodes) {
      const orig = n.nodeValue;
      const zh = lookup(orig.trim());
      if (!zh) continue;
      if (records.some((r) => r.kind === 'text' && r.node === n)) continue;
      records.push({ kind: 'text', node: n, orig });
      n.nodeValue = zh;
      count++;
    }
    return count;
  }

  /* =========================================================================
   * 6. 可选：在线机翻兜底（默认关闭）
   * ====================================================================== */
  const cache = new Map();

  function md5(str) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { const x4 = x & 0x40000000, y4 = y & 0x40000000, x8 = x & 0x80000000, y8 = y & 0x80000000; const r = (x & 0x3fffffff) + (y & 0x3fffffff); if (x4 & y4) return r ^ 0x80000000 ^ x8 ^ y8; if (x4 | y4) { if (r & 0x40000000) return r ^ 0xc0000000 ^ x8 ^ y8; return r ^ 0x40000000 ^ x8 ^ y8; } return r ^ x8 ^ y8; }
    function add32(a, b) { return (a + b) & 0xffffffff; }
    function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32(rl(a, s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function sb(s) {
      const n = ((s.length + 8) >> 6) + 1;
      const b = new Array(n * 16).fill(0);
      for (let i = 0; i < s.length; i++) b[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
      b[s.length >> 2] |= 0x80 << ((s.length % 4) * 8);
      b[n * 16 - 2] = s.length * 8;
      return b;
    }
    const x = sb(str);
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
      c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = add32(a, oa); b = add32(b, ob); c = add32(c, oc); d = add32(d, od);
    }
    let hex = '';
    for (const v of [a, b, c, d]) {
      for (let i = 0; i < 4; i++) hex += ((v >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  function httpPost(url, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: body, timeout: 15000,
          onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
        return;
      }
      fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then((r) => r.text().then((text) => resolve({ ok: r.ok, status: r.status, text })))
        .catch(reject);
    });
  }

  async function translateBatch(texts) {
    const out = [];
    if (settings.engine === 'google') {
      for (const src of texts) {
        const body = `client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(src)}`;
        const r = await httpPost('https://translate.googleapis.com/translate_a/single', body);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = JSON.parse(r.text);
        out.push(data[0].map((seg) => seg[0]).join(''));
      }
      return out;
    }
    if (settings.engine === 'mymemory') {
      for (const src of texts) {
        const body = `q=${encodeURIComponent(src)}&langpair=${encodeURIComponent('en|zh-CN')}`;
        const r = await httpPost('https://api.mymemory.translated.net/get', body);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        out.push(JSON.parse(r.text).responseData.translatedText);
      }
      return out;
    }
    return texts;
  }

  async function machineTranslate(nodes) {
    const pending = [];
    let count = 0;
    for (const n of nodes) {
      const t = n.nodeValue.trim();
      if (!translatable(t) || CJK.test(t)) continue;
      if (records.some((r) => r.kind === 'text' && r.node === n)) continue;
      pending.push(n);
    }
    for (let i = 0; i < pending.length; i += 8) {
      const chunk = pending.slice(i, i + 8);
      const texts = chunk.map((n) => n.nodeValue.trim());
      const key = (k) => `${settings.engine}:${md5(k)}`;
      const todo = texts.filter((t) => !cache.has(key(t)));
      if (todo.length) {
        const results = await translateBatch(todo);
        todo.forEach((t, idx) => cache.set(key(t), results[idx]));
      }
      for (const n of chunk) {
        const t = n.nodeValue.trim();
        const zh = cache.get(key(t));
        if (!zh || zh === t) continue;
        records.push({ kind: 'text', node: n, orig: n.nodeValue });
        n.nodeValue = zh;
        count++;
      }
      await sleep(120);
    }
    return count;
  }

  /* =========================================================================
   * 7. 入口
   * ====================================================================== */
  let translating = false;

  async function translateDocument() {
    if (translating) return 0;
    translating = true;
    try {
      let count = 0;
      const nodes = collectTextNodes(document.body || document.documentElement);
      count += translateNodes(nodes);
      count += translateAnchors();
      const titleEl = document.head && document.head.querySelector('title');
      const title = document.title;
      if (titleEl && title) {
        const zh = lookup(title.trim());
        if (zh) {
          records.push({ kind: 'text', node: titleEl.firstChild, orig: title });
          document.title = zh;
          count++;
        }
      }
      if (settings.engine !== 'off' && nodes.length) {
        try {
          count += await machineTranslate(nodes);
        } catch (e) {
          if (ui) ui.log('在线翻译失败：' + e.message + '（已跳过，界面词库仍然生效）', 'err');
        }
      }
      if (ui) ui.setStatus(count);
      return count;
    } finally {
      translating = false;
    }
  }

  /* =========================================================================
   * 8. 小面板 + 自动跟随
   * ====================================================================== */
  let ui = null;

  function buildUI() {
    if (document.querySelector('#ehzh-host')) return;
    const host = document.createElement('div');
    host.id = 'ehzh-host';
    host.innerHTML = `
      <div class="ehzh-bar">
        <span class="ehzh-title">汉化</span>
        <button type="button" data-act="now" title="手动翻译当前页面">翻译</button>
        <button type="button" data-act="undo" title="撤销本页所有翻译">撤销</button>
        <button type="button" data-act="hide" title="隐藏面板">×</button>
      </div>
      <div class="ehzh-out">就绪</div>`;
    Object.assign(host.style, {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: '2147483646',
      background: 'rgba(28,28,30,.94)', color: '#f2f2f7', border: '1px solid #3a3a3c',
      borderRadius: '10px', padding: '8px', fontSize: '12px', lineHeight: '1.5',
      fontFamily: 'system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
      minWidth: '150px', userSelect: 'none',
    });
    const st = document.createElement('style');
    st.textContent = `#ehzh-host .ehzh-bar{display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:move}
      #ehzh-host .ehzh-title{font-weight:600;margin-right:auto}
      #ehzh-host button{all:unset;cursor:pointer;padding:2px 7px;border-radius:6px;background:#3a3a3c;color:#f2f2f7}
      #ehzh-host button:hover{background:#48484a}
      #ehzh-host .ehzh-out{color:#aeaeb2;max-width:260px;word-break:break-all;min-height:16px}`;
    host.appendChild(st);
    (document.body || document.documentElement).appendChild(host);

    const out = host.querySelector('.ehzh-out');
    ui = {
      log(msg, kind = 'info') {
        out.textContent = msg;
        out.style.color = kind === 'err' ? '#ff6961' : kind === 'ok' ? '#30d158' : '#aeaeb2';
      },
      setStatus(n) { out.textContent = n > 0 ? `已翻译 ${n} 处` : '没有可翻译的界面文案'; },
    };
    host.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'now') {
        ui.log('翻译中…');
        try {
          const n = await translateDocument();
          ui.log(`本次翻译 ${n} 处`, 'ok');
        } catch (err) {
          ui.log('翻译失败：' + err.message, 'err');
        }
      } else if (act === 'undo') {
        revertAll();
        ui.log('已撤销');
      } else if (act === 'hide') {
        host.style.display = 'none';
        document.addEventListener('dblclick', () => { host.style.display = ''; }, { once: true });
      }
    });

    const bar = host.querySelector('.ehzh-bar');
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, left: host.offsetLeft, top: host.offsetTop };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      host.style.left = Math.max(0, drag.left + e.clientX - drag.x) + 'px';
      host.style.top = Math.max(0, drag.top + e.clientY - drag.y) + 'px';
      host.style.bottom = 'auto';
    });
    bar.addEventListener('pointerup', () => { drag = null; });
  }

  let timer = null;
  function scheduleTranslate() {
    clearTimeout(timer);
    timer = setTimeout(() => translateDocument().catch(() => {}), 450);
  }

  function watchMutations() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.id === 'ehzh-host' || (node.closest && node.closest('#ehzh-host'))) continue;
          if (node.closest && node.closest('.nbw')) continue;
          scheduleTranslate();
          return;
        }
      }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    buildUI();
    if (settings.auto) {
      translateDocument().catch(() => {});
    }
    watchMutations();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DICT, PATTERNS, lookup, translateDocument, revertAll, collectTextNodes,
      translateAnchors, translateNodes, translatable, md5, EXCLUDE, isExcluded,
      __settings: settings,
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
