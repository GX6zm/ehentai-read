// ==UserScript==
// @name         E-Hentai 画廊下载器
// @namespace    https://local/ehdl
// @version      1.3.0
// @description  在 E-Hentai / ExHentai 一键打包下载画廊原图：多画廊队列、断点续传、失败重试、限速保护、逐图存文件夹
// @author       local
// @match        https://e-hentai.org/*
// @match        https://exhentai.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 0. 自定义异常
   * ====================================================================== */
  class StopError extends Error {
    /** kind: 'abort' | 'limit' | 'ban' | 'throttle' | 'fatal' */
    constructor(kind, message) {
      super(message);
      this.name = 'StopError';
      this.kind = kind;
    }
  }

  /* =========================================================================
   * 1. 基础工具
   * ====================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ORIGIN = location.origin;
  const STORE_PREFIX = 'ehdl.v1.';
  // 缓存里的原图地址格式变了就作废（1.0.0 存的是只按 URL 命名的老列表，混着登录页地址）
  const STATE_VER = 2;

  const store = {
    get(key, def) {
      try {
        const v = GM_getValue(STORE_PREFIX + key);
        return v === undefined || v === null ? def : v;
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try { GM_setValue(STORE_PREFIX + key, val); } catch (e) { /* ignore */ }
    },
    del(key) {
      try { GM_deleteValue(STORE_PREFIX + key); } catch (e) { /* ignore */ }
    },
  };

  const settings = Object.assign(
    {
      mode: 'zip',        // 'zip' | 'folder'
      concurrency: 3,     // 同时进行的图片请求数
      gap: 700,           // 相邻请求的最小间隔（毫秒）
      infoFile: true,     // 是否附带 info.txt
      rescan: false,      // 恢复任务时是否重新扫描画廊页
      maxFavPages: 20,    // 抓取收藏夹最多翻多少页
      autoStart: true,    // 加入队列后自动开跑
      webpToJpg: true,    // 只能拿到 webp/avif 时，转成 jpg 存盘（Windows 照片查看器默认不认 webp）
    },
    store.get('settings', {}) || {}
  );

  const saveSettings = () => store.set('settings', settings);

  const isEx = () => /(^|\.)exhentai\.org$/.test(location.hostname);

  function sanitize(name, maxLen = 80) {
    let s = String(name || '')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    if (!s) s = 'gallery';
    if (s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s;
  }

  const padNum = (n, w) => String(n).padStart(w, '0');

  function extFromUrl(url) {
    try {
      const path = new URL(url, ORIGIN).pathname;
      const m = path.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return m[1].toLowerCase();
    } catch (e) { /* ignore */ }
    return 'jpg';
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms <= 0) return '--:--';
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  /* =========================================================================
   * 2. CRC32 + ZIP 写入器（STORE 方式，JPEG 本身不可再压，省 CPU）
   * ====================================================================== */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  const textEncoder = new TextEncoder();

  class ZipWriter {
    /** @param {(bytes: Uint8Array) => void | Promise<void>} writeChunk */
    constructor(writeChunk) {
      this.writeChunk = writeChunk;
      this.offset = 0;
      this.entries = [];
    }

    async _put(bytes) {
      await this.writeChunk(bytes);
      this.offset += bytes.byteLength;
    }

    async add(name, data) {
      const nameBytes = textEncoder.encode(name);
      const crc = crc32(data);
      const { time, date } = dosDateTime(new Date());
      const head = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);      // version needed
      dv.setUint16(6, 0x0800, true);  // UTF-8 文件名
      dv.setUint16(8, 0, true);       // method = store
      dv.setUint16(10, time, true);
      dv.setUint16(12, date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.byteLength, true);
      dv.setUint32(22, data.byteLength, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      head.set(nameBytes, 30);

      const localOffset = this.offset;
      await this._put(head);
      await this._put(data);
      this.entries.push({ nameBytes, crc, size: data.byteLength, time, date, localOffset });
    }

    async finish() {
      if (this.entries.length > 0xffff) {
        throw new Error('文件数超过 65535，请改用「逐图存文件夹」模式');
      }
      const cdStart = this.offset;
      for (const e of this.entries) {
        const rec = new Uint8Array(46 + e.nameBytes.length);
        const dv = new DataView(rec.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, e.time, true);
        dv.setUint16(14, e.date, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.size, true);
        dv.setUint32(24, e.size, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, e.localOffset, true);
        rec.set(e.nameBytes, 46);
        await this._put(rec);
      }
      const cdSize = this.offset - cdStart;
      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, this.entries.length, true);
      dv.setUint16(10, this.entries.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, cdStart, true);
      dv.setUint16(20, 0, true);
      await this._put(eocd);
    }
  }

  /* =========================================================================
   * 3. 输出目标（Sink）
   * ====================================================================== */
  const ZIP_SOFT_LIMIT = 1.6 * 1024 * 1024 * 1024; // 内存打包的软上限

  class MemoryZipSink {
    constructor() {
      this.parts = [];
      this.total = 0;
      this.zip = new ZipWriter((bytes) => {
        this.parts.push(bytes);
        this.total += bytes.byteLength;
        if (this.total > ZIP_SOFT_LIMIT) {
          throw new StopError('fatal', '内容超过 1.6GB，内存打包会失败，请切换到「逐图存文件夹」模式');
        }
      });
      this.names = new Set();
    }
    exists(name) { return this.names.has(name); }
    async add(name, data) {
      await this.zip.add(name, data);
      this.names.add(name);
    }
    async finalize() {
      await this.zip.finish();
      return new Blob(this.parts, { type: 'application/zip' });
    }
    get size() { return this.total; }
  }

  class FolderSink {
    constructor(dir) { this.dir = dir; this.total = 0; }
    async exists(name) {
      try { await this.dir.getFileHandle(name); return true; } catch (e) { return false; }
    }
    async add(name, data) {
      const fh = await this.dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
      this.total += data.byteLength;
    }
    async finalize() { return null; }
    get size() { return this.total; }
  }

  /* =========================================================================
   * 4. 网络层：限速器 + GM_xmlhttpRequest 封装 + 重试
   * ====================================================================== */
  class Limiter {
    constructor(maxConcurrent, minGap) {
      this.max = Math.max(1, maxConcurrent);
      this.gap = Math.max(0, minGap);
      this.active = 0;
      this.last = 0;
      this.queue = [];
      this.timer = null;
    }
    setRate(maxConcurrent, minGap) {
      this.max = Math.max(1, maxConcurrent);
      this.gap = Math.max(0, minGap);
      this._pump();
    }
    run(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this._pump();
      });
    }
    _pump() {
      if (this.timer) return;
      while (this.active < this.max && this.queue.length > 0) {
        const wait = this.last + this.gap - Date.now();
        if (wait > 0) {
          this.timer = setTimeout(() => { this.timer = null; this._pump(); }, wait);
          return;
        }
        const job = this.queue.shift();
        this.active++;
        this.last = Date.now();
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => { this.active--; this._pump(); });
      }
    }
  }

  const limiter = new Limiter(settings.concurrency, settings.gap);

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  /**
   * 发一个 GET。
   * 同源（e-hentai.org 的页面、/fullimg/）走页面 fetch：登录 cookie 一定带上。
   * 早先全走 GM_xmlhttpRequest，某些浏览器/版本下它不带 e-hentai 的 cookie，
   * 于是已登录的用户也会被当成匿名，/fullimg/ 跳登录页，只剩 hath 的重采样 webp。
   * 跨域（*.hath.network 图床）才需要 GM_xmlhttpRequest 绕 CORS。
   */
  function gmRequest(url, { binary = false, timeout = 90000 } = {}) {
    if (sameOrigin(url) && typeof fetch === 'function') {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
      return fetch(url, { credentials: 'include', signal: ctrl ? ctrl.signal : undefined })
        .then(async (res) => {
          const buf = await res.arrayBuffer();
          return binary
            ? { status: res.status, response: buf }
            : { status: res.status, responseText: new TextDecoder('utf-8').decode(buf) };
        })
        .finally(() => { if (timer) clearTimeout(timer); });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout,
          responseType: binary ? 'arraybuffer' : 'text',
          onload: (r) => done(resolve, r),
          onerror: (e) => done(reject, new Error(`网络错误: ${(e && e.error) || '未知'}`)),
          ontimeout: () => done(reject, new Error('请求超时')),
          onabort: () => done(reject, new Error('请求被中止')),
        });
      } catch (e) {
        done(reject, e);
      }
    });
  }

  const BAN_PATTERNS = [
    /You have reached the image viewing limit/i,
    /You are currently at your image viewing limit/i,
    /image viewing limit/i,
  ];
  const HARD_BAN_PATTERNS = [
    /temporarily banned/i,
    /temporarily blocked/i,
    /Your IP address has been/i,
  ];
  const THROTTLE_PATTERNS = [
    /request rate is too high/i,
    /hit the server too fast/i,
    /Too many requests/i,
  ];

  function inspectHtml(html, url) {
    if (!html) return;
    for (const re of HARD_BAN_PATTERNS) {
      if (re.test(html)) throw new StopError('ban', `IP 被临时封禁（${url}），请等待一段时间再试`);
    }
    for (const re of BAN_PATTERNS) {
      if (re.test(html)) throw new StopError('limit', '已达 E-Hentai 每日浏览上限，请明天再试或放慢速度');
    }
    for (const re of THROTTLE_PATTERNS) {
      if (re.test(html)) throw new StopError('throttle', '请求过快被限流，正在退避');
    }
  }

  /** 带重试的文本请求 */
  async function fetchText(url, { retries = 3, label = '页面' } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await limiter.run(() => gmRequest(url, { binary: false }));
        if (r.status >= 200 && r.status < 300) {
          const html = r.responseText || '';
          inspectHtml(html, url);
          return html;
        }
        if (r.status === 502 || r.status === 503 || r.status === 509 || r.status === 429) {
          lastErr = new Error(`HTTP ${r.status}`);
          await sleep(4000 * (attempt + 1));
          continue;
        }
        if (r.status === 404 || r.status === 410) {
          throw new StopError('fatal', `${label}不存在（HTTP ${r.status}）：${url}`);
        }
        lastErr = new Error(`HTTP ${r.status}：${url}`);
      } catch (e) {
        if (e instanceof StopError) throw e;
        lastErr = e;
      }
      await sleep(800 * Math.pow(2, attempt));
    }
    throw lastErr || new Error(`请求失败：${url}`);
  }

  /** 带重试的二进制请求 */
  async function fetchBinary(url, { retries = 3 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await limiter.run(() => gmRequest(url, { binary: true }));
        if (r.status >= 200 && r.status < 300) {
          const buf = r.response;
          if (!(buf instanceof ArrayBuffer)) throw new Error('返回的不是二进制数据');
          if (buf.byteLength === 0) throw new Error('返回内容为空');
          return new Uint8Array(buf);
        }
        if (r.status === 502 || r.status === 503 || r.status === 509 || r.status === 429) {
          lastErr = new Error(`HTTP ${r.status}`);
          await sleep(4000 * (attempt + 1));
          continue;
        }
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (e instanceof StopError) throw e;
        lastErr = e;
      }
      await sleep(700 * Math.pow(2, attempt));
    }
    throw lastErr || new Error('下载失败');
  }

  /* =========================================================================
   * 5. 解析
   * ====================================================================== */
  function parseGalleryUrl(url) {
    const m = String(url).match(/\/g\/(\d+)\/([0-9a-z]+)/i);
    if (!m) return null;
    return { gid: m[1], token: m[2], base: `${ORIGIN}/g/${m[1]}/${m[2]}/` };
  }

  function parseGalleryMeta(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const titleEl = doc.querySelector('#gn');
    const title = (titleEl ? titleEl.textContent : doc.title || '').trim().replace(/\s*-\s*E-?Hentai.*$/i, '');
    const rows = {};
    doc.querySelectorAll('#gdd tr').forEach((tr) => {
      const k = (tr.children[0] ? tr.children[0].textContent : '').trim().replace(/:$/, '');
      const v = (tr.children[1] ? tr.children[1].textContent : '').trim();
      if (k) rows[k] = v;
    });
    const tags = [];
    // 标签的 DOM 是「命名空间链接 + 标签名链接」两个 <a> 拼在一个 <td> 里
    // （如 <a class="gt">female:</a><a class="gtl">chies mother</a>），必须按单元格取全文
    const tagCells = doc.querySelectorAll('#taglist td');
    if (tagCells.length) {
      tagCells.forEach((td) => {
        const t = (td.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t !== '+' && !/^\+$/.test(t)) tags.push(t);
      });
    } else {
      doc.querySelectorAll('#taglist a').forEach((a) => {
        const t = a.textContent.trim();
        if (t && t !== '+' && !/^\+$/.test(t)) tags.push(t);
      });
    }
    const length = parseInt(rows['Length'] || '0', 10) || 0;
    return { title, rows, tags, length };
  }

  function parseThumbLinks(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const seen = new Set();
    // 正常布局：缩略图都在 #gdt 里；#gdt 缺失时退化为全页扫描（用 gid-页码 形态过滤）
    const scope = doc.querySelector('#gdt') || doc.body || doc;
    scope.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!/\/s\/[0-9a-z]{6,}\/\d+-\d+/i.test(href)) return;
      let abs;
      try { abs = new URL(href, baseUrl).href; } catch (e) { return; }
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    });
    return out;
  }

  function absUrl(u) {
    if (!u) return '';
    if (u.startsWith('//')) return location.protocol + u;
    if (/^https?:/i.test(u)) return u;
    try { return new URL(u, ORIGIN).href; } catch (e) { return ''; }
  }

  /** 日志里用的短地址：主机 + 路径前 28 字 */
  function shortUrl(u) {
    try {
      const x = new URL(u);
      return `${x.hostname}${x.pathname.slice(0, 28) || ''}`;
    } catch (e) {
      return String(u).slice(0, 40);
    }
  }

  /**
   * 从图片详情页取出原图地址。真实页面结构（2026-10 实测）：
   *   <a href="https://e-hentai.org/fullimg/<gid>/<page>/<token>/<name>.jpg">Download original 1968 x 2528 664.7 KiB</a>
   *   <img id="img" src="https://<host>.hath.network/h/<hash>-<size>-<w>-<h>-jpg/keystamp=...;fileindex=...;xres=org/<name>.jpg">
   * 注意：#i6 里的第一个 <a> 是 “Show galleries with this image” 搜索链接，绝对不能当原图用。
   * @returns {{src:string, candidates:string[], pageNo:string}}
   */
  function parseImagePage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const candidates = [];
    const push = (u) => {
      const abs = absUrl(u);
      if (abs && !candidates.includes(abs)) candidates.push(abs);
    };

    // 1) 原图直链（图片被缩放时才出现，指向 fullimg）
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!/\/fullimg\//i.test(href)) continue;
      if (!/^download original/i.test((a.textContent || '').trim())) continue;
      push(href);
    }
    // 2) 页面正在展示的图片：xres=org 时它本身就是原图
    const img = doc.querySelector('#img');
    if (img) push(img.getAttribute('src') || '');
    // 3) 兜底：仍挂到 #i6 上的图片类链接
    const box = doc.querySelector('#i6');
    if (box) {
      for (const a of box.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (/\/(fullimg|img)\//i.test(href) || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(href.split('?')[0])) push(href);
      }
    }

    const pageNo = (doc.querySelector('#i2') ? doc.querySelector('#i2').textContent : '').trim();
    return { src: candidates[0] || '', candidates, pageNo };
  }

  /**
   * 读文件头，返回真实图片格式（扩展名）：'jpg'|'png'|'gif'|'webp'|'bmp'|'avif'，不是图片返回 ''。
   * 存盘扩展名以它为准，不信任 URL 后缀——E-Hentai 的 /fullimg/xxx.jpg 在没有登录态时
   * 会重定向到 bounce_login.php 返回 HTML，而 hath.network 给的是 webp；
   * 只按 URL 命名就会把 webp 字节存成 001.jpg（Windows 照片查看器打不开）。
   */
  function imageKind(ab) {
    if (!ab || ab.byteLength < 12) return '';
    const u = new Uint8Array(ab, 0, Math.min(16, ab.byteLength));
    const at = (i) => u[i] || 0;
    const ascii = (i, n) => String.fromCharCode.apply(null, Array.from(u.slice(i, i + n)));
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg';  // jpeg
    if (at(0) === 0x89 && ascii(1, 3) === 'PNG') return 'png';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
    if (at(0) === 0x42 && at(1) === 0x4d) return 'bmp';
    if (ascii(4, 4) === 'ftyp' && /^(avif|avis|heic|heix|mif1)/.test(ascii(8, 4))) return 'avif';
    return '';
  }

  /** 用文件头判断拿到的确实是图片，避免把 HTML 错误页当成图片存盘 */
  function sniffImage(ab) {
    return imageKind(ab) !== '';
  }

  /** 响应看起来像 HTML（登录跳转页 / 错误页）时给一句人话提示 */
  function looksLikeHtml(ab) {
    if (!ab || !ab.byteLength) return false;
    const u = new Uint8Array(ab, 0, Math.min(64, ab.byteLength));
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return /^\s*</.test(s) && /<!doctype html|<html|bounce_login/i.test(s);
  }

  /**
   * 把 webp/avif 重新编码成 JPEG（浏览器画布，全程本地）。
   * 未登录 E-Hentai 时 /fullimg/ 会跳到登录页，只能退到 hath.network 的重采样 webp；
   * Windows 照片查看器默认没有 WebP 解码器，存成 .webp 一样打不开，所以默认转码。
   */
  async function convertToJpeg(ab) {
    try {
      const blob = new Blob([ab], { type: 'image/webp' });
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // webp 可能有透明底，铺白底避免变黑
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0);
      const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (!out) return null;
      return await out.arrayBuffer();
    } catch (e) {
      return null;
    }
  }

  /* =========================================================================
   * 6. 画廊任务
   * ====================================================================== */
  let ui = null; // 由 buildUI 注入

  class GalleryJob {
    constructor(url) {
      this.url = url;
      const info = parseGalleryUrl(url);
      if (!info) throw new StopError('fatal', '不是有效的画廊链接：' + url);
      this.gid = info.gid;
      this.token = info.token;
      this.base = info.base;
      this.key = 'state.' + this.gid;
      this.paused = false;
      this.aborted = false;
      this.title = '';
      this.total = 0;
      this.doneCount = 0;
      this.failedIds = [];
      this.bytes = 0;
      this.startTime = 0;
      this._kinds = {}; // 本次实际写入的格式统计（诊断用）
      this.state = this._loadState();
    }

    _loadState() {
      const s = store.get(this.key, null);
      if (s && s.ver === STATE_VER && Array.isArray(s.urls) && Array.isArray(s.pageUrls)) {
        if (!Array.isArray(s.done)) s.done = [];
        if (!Array.isArray(s.alt)) s.alt = [];
        return s;
      }
      return { ver: STATE_VER, title: '', pageUrls: [], urls: [], alt: [], done: [], savedAt: 0 };
    }

    _saveState() {
      this.state.ver = STATE_VER;
      this.state.title = this.title || this.state.title;
      this.state.savedAt = Date.now();
      store.set(this.key, this.state);
      pruneStates(this.key);
    }

    async checkpoint() {
      if (this.aborted) throw new StopError('abort', '已停止');
      while (this.paused) {
        await sleep(200);
        if (this.aborted) throw new StopError('abort', '已停止');
      }
    }

    async run() {
      this.startTime = Date.now();
      await this.checkpoint();

      /* --- 阶段 1：扫描画廊页，拿到所有缩略图（图片页）链接 --- */
      let pageUrls = this.state.pageUrls && this.state.pageUrls.length ? this.state.pageUrls : null;
      if (!pageUrls || settings.rescan) {
        ui.progress({ phase: '扫描画廊页' });
        pageUrls = await this._crawlGalleryPages();
        this.state.pageUrls = pageUrls;
        this.state.urls = new Array(pageUrls.length).fill('');
        this._saveState();
      } else {
        // 续传：复用已缓存的页面列表，标题/元数据也一并恢复
        this.title = this.state.title || this.title;
        this.meta = this.meta || this.state.meta || null;
      }
      this.total = pageUrls.length;
      if (this.total === 0) {
        throw new StopError('fatal', '没有找到任何图片，可能是空画廊、内容警告页或需要登录');
      }
      ui.info(`${this.title} · 共 ${this.total} 页`);
      await this.checkpoint();

      /* --- 阶段 2：解析每页的原图直链（断点续传：已有直链直接复用） --- */
      const urls = this.state.urls.length === this.total
        ? this.state.urls.slice()
        : new Array(this.total).fill('');
      const alts = Array.isArray(this.state.alt) && this.state.alt.length === this.total
        ? this.state.alt.slice()
        : new Array(this.total).fill(null);
      const needResolve = urls.filter((u) => !u).length;
      if (needResolve > 0) {
        await this._resolveUrls(pageUrls, urls, alts);
      }
      this.state.urls = urls;
      this.state.alt = alts;
      this._saveState();

      /* --- 阶段 3：准备输出目标 --- */
      const sink = await this._openSink();
      if (!sink) throw new StopError('abort', '未选择保存位置');

      /* --- 阶段 4：下载并写入（按顺序，支持跳过已存在文件） --- */
      this.pad = Math.max(3, String(this.total).length);
      const conc = Math.max(1, Math.min(8, settings.concurrency));

      let lastTick = Date.now();
      let lastDone = 0;
      let speed = 0;   // 页/秒（算 ETA）
      let lastBytes = 0;
      let bps = 0;     // 字节/秒（显示速度）

      for (let base = 0; base < this.total; base += conc) {
        await this.checkpoint();
        const slice = [];
        for (let i = base; i < Math.min(base + conc, this.total); i++) slice.push(i);

        const results = await Promise.all(
          slice.map(async (i) => {
            if (!urls[i]) {
              ui.log(`第 ${i + 1} 页缺少原图地址，跳过`, 'warn');
              return { i, name: '', data: null };
            }
            // 已存在检查：扩展名可能因回退（jpg→webp）而不同，六种都探一遍
            for (const e of ['jpg', 'webp', 'png', 'gif', 'bmp', 'avif']) {
              const probe = this._fileName(i, '', e);
              if (await sink.exists(probe)) return { i, name: probe, skipped: true };
            }
            const tried = [];
            const grab = async (list) => {
              let lastErr = new Error('没有可用的原图地址');
              for (const u of list) {
                try {
                  let data = await fetchBinary(u);
                  let kind = imageKind(data);
                  if (!kind) {
                    tried.push(`${shortUrl(u)} → ${looksLikeHtml(data) ? 'HTML' : '非图片'}(${data.byteLength}B)`);
                    lastErr = new Error(looksLikeHtml(data)
                      ? '返回的是登录页/错误页（原图链接需要先登录 E-Hentai）'
                      : '返回内容不是图片');
                    continue;
                  }
                  if (kind === 'webp' || kind === 'avif') {
                    if (settings.webpToJpg !== false) {
                      const conv = await convertToJpeg(data);
                      if (conv && imageKind(conv) === 'jpg') { data = conv; kind = 'jpg'; }
                    }
                    if (!this._webpHinted) {
                      this._webpHinted = true;
                      ui.log('该画廊只取到重采样 webp/avif：已转成 JPG 保存（设置里可关闭）；要真原图请在浏览器登录 E-Hentai', 'warn');
                    }
                  }
                  // 名字跟着「真正拿到的字节」走，避免 webp 存成 .jpg
                  return { i, name: this._fileName(i, u, kind), data };
                } catch (e) {
                  if (e instanceof StopError) throw e;
                  tried.push(`${shortUrl(u)} → ${e.message}`);
                  lastErr = e;
                }
              }
              throw new Error(`${lastErr.message}｜已试 ${tried.join(' / ') || '无候选'}`);
            };

            try {
              return await grab([urls[i], ...((alts[i] || []).filter(Boolean))]);
            } catch (e) {
              if (e instanceof StopError) throw e;
              // 自愈：缓存里的地址可能来自老版本（只有 /fullimg/，没有 hath 备用地址）。
              // 失败一次就回捞图片页重新解析，避免整个任务被历史缓存卡死。
              try {
                const html = await fetchText(pageUrls[i], { label: '图片页' });
                const fresh = parseImagePage(html).candidates;
                if (fresh.length) {
                  urls[i] = fresh[0];
                  alts[i] = fresh.slice(1);
                  this.state.urls = urls;
                  this.state.alt = alts;
                  return await grab(fresh);
                }
              } catch (e2) {
                if (e2 instanceof StopError) throw e2;
              }
              this.failedIds.push(i);
              ui.log(`第 ${i + 1} 页失败：${e.message}`, 'err');
              return { i, name: '', data: null };
            }
          })
        );

        for (const r of results) {
          if (r.skipped) {
            this.doneCount++;
            continue;
          }
          if (!r.data) continue;
          await sink.add(r.name, r.data);
          const _ext = String(r.name).split('.').pop().toLowerCase();
          this._kinds[_ext] = (this._kinds[_ext] || 0) + 1;
          this.bytes += r.data.byteLength;
          this.doneCount++;
          if (!this.state.done.includes(r.i)) this.state.done.push(r.i);
        }

        const now = Date.now();
        const dt = now - lastTick;
        if (dt > 800) {
          speed = ((this.doneCount - lastDone) * 1000) / dt;
          bps = ((this.bytes - lastBytes) * 1000) / dt;
          lastTick = now;
          lastDone = this.doneCount;
          lastBytes = this.bytes;
        }
        const remain = this.total - this.doneCount;
        ui.progress({
          phase: '下载',
          done: this.doneCount,
          total: this.total,
          bytes: this.bytes,
          eta: speed > 0 ? (remain / speed) * 1000 : Infinity,
          size: sink.size,
          bps,
        });
        if (this.doneCount % 20 === 0) this._saveState();
      }

      await this.checkpoint();

      const kindTxt = Object.entries(this._kinds || {}).map(([k, n]) => `${k} ×${n}`).join('，');
      if (kindTxt) ui.log(`本次写入格式：${kindTxt}`);

      /* --- 阶段 5：收尾 --- */
      if (settings.infoFile) {
        const meta = this._buildInfoText();
        const infoName = 'info.txt';
        if (!(await sink.exists(infoName))) {
          await sink.add(infoName, textEncoder.encode(meta));
        }
      }

      if (sink instanceof MemoryZipSink) {
        const blob = await sink.finalize();
        const fname = sanitize(this.title || `gallery_${this.gid}`) + '.zip';
        triggerDownload(blob, fname);
        ui.info(`已生成 ${fname}（${fmtBytes(blob.size)}）`);
      } else {
        ui.info(`已保存 ${this.doneCount} 个文件到文件夹`);
      }

      this._saveState();
      if (this.failedIds.length) {
        ui.log(`有 ${this.failedIds.length} 页失败，可再次运行本任务重试`, 'warn');
      }
      return { failed: this.failedIds.length, skipped: 0 };
    }

    async _crawlGalleryPages() {
      const all = [];
      const seen = new Set();
      for (let p = 0; p < 1000; p++) {
        await this.checkpoint();
        const html = await fetchText(`${this.base}?p=${p}`, { label: '画廊页' });
        if (p === 0) {
          if (/Content Warning|This gallery contains/i.test(html) && !/#gd2|id="gdt"/.test(html)) {
            throw new StopError('fatal', '该画廊有内容警告/年龄确认页，请先在浏览器中打开并确认后再试');
          }
          if (/You must be logged in|Sad Panda/i.test(html)) {
            throw new StopError('fatal', '需要登录：请在浏览器登录 E-Hentai/ExHentai 后重试');
          }
          const meta = parseGalleryMeta(html);
          this.title = meta.title || this.title;
          this.meta = meta;
          this.state.meta = { title: meta.title, rows: meta.rows, tags: meta.tags };
        }
        const links = parseThumbLinks(html, this.base);
        if (links.length === 0) break;
        let added = 0;
        for (const l of links) {
          if (seen.has(l)) continue;
          seen.add(l);
          all.push(l);
          added++;
        }
        if (added === 0) break;
        ui.progress({ phase: '扫描画廊页', done: p + 1, total: 0, pages: all.length });
      }
      return all;
    }

    async _resolveUrls(pageUrls, urls, alts) {
      const conc = Math.min(3, Math.max(1, settings.concurrency));
      for (let base = 0; base < pageUrls.length; base += conc) {
        await this.checkpoint();
        const idx = [];
        for (let i = base; i < Math.min(base + conc, pageUrls.length); i++) {
          if (!urls[i]) idx.push(i);
        }
        if (!idx.length) continue;

        await Promise.all(
          idx.map(async (i) => {
            try {
              const html = await fetchText(pageUrls[i], { label: '图片页' });
              const { candidates } = parseImagePage(html);
              if (!candidates.length) throw new Error('未找到原图链接');
              urls[i] = candidates[0];
              alts[i] = candidates.slice(1);
            } catch (e) {
              if (e instanceof StopError) throw e;
              this.failedIds.push(i);
              ui.log(`解析第 ${i + 1} 页失败：${e.message}`, 'err');
            }
          })
        );

        const resolved = urls.filter(Boolean).length;
        ui.progress({ phase: '解析原图地址', done: resolved, total: pageUrls.length });
        if (base % (conc * 20) === 0) {
          this.state.urls = urls;
          this.state.alt = alts;
          this._saveState();
        }
      }
      this.state.urls = urls;
      this.state.alt = alts;
      this._saveState();
      const withAlt = alts.filter((a) => a && a.length).length;
      ui.log(`原图地址解析完成：${urls.filter(Boolean).length}/${pageUrls.length} 页，其中 ${withAlt} 页有备用地址`);
    }

    async _openSink() {
      if (settings.mode === 'folder') {
        const root = await ensureDirHandle();
        if (!root) return null;
        const sub = await root.getDirectoryHandle(sanitize(this.title || `gallery_${this.gid}`), { create: true });
        return new FolderSink(sub);
      }
      return new MemoryZipSink();
    }

    _fileName(i, url, kind) {
      const ext = kind || extFromUrl(url || '');
      return `${padNum(i + 1, this.pad || 3)}.${ext}`;
    }

    _buildInfoText() {
      const m = this.meta || {};
      const lines = [];
      lines.push(`标题: ${this.title || ''}`);
      lines.push(`地址: ${this.url}`);
      lines.push(`页数: ${this.total}`);
      if (m.rows) {
        for (const k of ['Category', 'Language', 'File Size', 'Length', 'Favorited', 'Rating']) {
          if (m.rows[k]) lines.push(`${k}: ${m.rows[k]}`);
        }
      }
      if (m.tags && m.tags.length) {
        lines.push('');
        lines.push('标签:');
        lines.push(m.tags.join(', '));
      }
      lines.push('');
      lines.push(`下载时间: ${new Date().toLocaleString()}`);
      return lines.join('\n');
    }
  }

  /* ---------- 状态存储维护（只保留最近 40 个任务） ---------- */
  function pruneStates(exceptKey) {
    try {
      const index = store.get('stateIndex', []) || [];
      const i = index.indexOf(exceptKey);
      if (i >= 0) index.splice(i, 1);
      index.unshift(exceptKey);
      while (index.length > 40) {
        const old = index.pop();
        if (old) store.del(old);
      }
      store.set('stateIndex', index);
    } catch (e) { /* ignore */ }
  }

  /** 目录句柄在会话内复用；刷新页面后需要重新授权 */
  let dirHandleCache = null;
  async function ensureDirHandle() {
    if (dirHandleCache) return dirHandleCache;
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new StopError('fatal', '当前浏览器不支持文件夹保存（需要 Chromium 内核），请改用 ZIP 模式');
    }
    try {
      dirHandleCache = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ehdl' });
      return dirHandleCache;
    } catch (e) {
      return null;
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 120000);
  }

  /* =========================================================================
   * 7. 队列
   * ====================================================================== */
  const queue = [];
  const QUEUE_KEY = 'queue';   // 队列存档：刷新/重开页面后能恢复
  let qid = 0;
  let queueRunning = false;
  let currentJob = null;
  let stopQueue = false;

  function addToQueue(urls) {
    let n = 0;
    const seen = new Set(queue.filter((q) => q.status !== 'done').map((q) => q.url));
    for (const raw of urls) {
      const u = String(raw).trim();
      const info = parseGalleryUrl(u);
      if (!info) continue;
      const norm = info.base;
      if (seen.has(norm)) continue;
      seen.add(norm);
      queue.push({ id: ++qid, url: norm, title: '', status: 'pending' });
      n++;
    }
    renderQueue();
    saveQueue();
    ui.log(`已加入队列 ${n} 个画廊`);
    if (!queueRunning && n > 0 && settings.autoStart) runQueue();
    return n;
  }

  /** 把队列里还没完成的项写进 GM 存储（刷新/关页面后能恢复） */
  function saveQueue() {
    try {
      const list = queue
        .filter((q) => q.status !== 'done')
        .map((q) => ({ url: q.url, title: q.title || '', status: q.status === 'running' ? 'pending' : q.status }));
      store.set(QUEUE_KEY, list);
    } catch (e) {
      // 存储失败不影响下载
    }
  }

  /** 读取上次没跑完的队列，恢复成待下状态（不会自动开始）。返回恢复条数 */
  function restoreQueue() {
    const list = store.get(QUEUE_KEY, []) || [];
    if (!Array.isArray(list) || !list.length) return 0;
    const seen = new Set(queue.map((q) => q.url));
    let n = 0;
    for (const it of list) {
      const info = parseGalleryUrl((it && it.url) || '');
      if (!info || seen.has(info.base)) continue;
      seen.add(info.base);
      queue.push({ id: ++qid, url: info.base, title: (it && it.title) || '', status: 'pending' });
      n++;
    }
    if (n) renderQueue();
    return n;
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    stopQueue = false;
    renderQueue();
    while (true) {
      const item = queue.find((q) => q.status === 'pending');
      if (!item || stopQueue) break;
      item.status = 'running';
      renderQueue();
      currentJob = new GalleryJob(item.url);
      const pauseBtn = document.getElementById('ehdl-host');
      if (pauseBtn && pauseBtn.shadowRoot) {
        const b = pauseBtn.shadowRoot.getElementById('btn-pause');
        if (b) b.textContent = '暂停';
      }
      try {
        await currentJob.run();
        item.status = 'done';
        if (currentJob.title) item.title = currentJob.title;
      } catch (e) {
        if (e instanceof StopError && e.kind === 'abort') {
          item.status = 'pending';
        } else if (e instanceof StopError && e.kind === 'throttle') {
          // 被限流：退避后重跑同一任务（最多 5 次）
          item.throttleRetries = (item.throttleRetries || 0) + 1;
          ui.log(`触发限流，20 秒后重试（第 ${item.throttleRetries} 次）`, 'warn');
          if (item.throttleRetries > 5) {
            item.status = 'stopped';
            stopQueue = true;
          } else {
            item.status = 'pending';
            renderQueue();
            await sleep(20000);
          }
        } else if (e instanceof StopError) {
          item.status = 'stopped';
          ui.log(e.message, 'err');
          stopQueue = true;
        } else {
          item.status = 'error';
          ui.log(`${item.url}：${e.message}`, 'err');
        }
      }
      renderQueue();
      saveQueue();
      currentJob = null;
      await sleep(1200);
    }
    queueRunning = false;
    saveQueue();
    ui.progress({ phase: '空闲' });
    renderQueue();
  }

  function stopAll() {
    stopQueue = true;
    if (currentJob) currentJob.aborted = true;
  }

  /* =========================================================================
   * 8. UI
   * ====================================================================== */
  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: 340px;
      font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #e8e8ea; background: #1c1d21; border: 1px solid #35363c;
      border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.45);
      z-index: 2147483000; overflow: hidden; user-select: none;
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #24252b; cursor: move; }
    .head b { font-size: 12px; font-weight: 600; letter-spacing: .3px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; }
    .dot.busy { background: #fbbf24; box-shadow: 0 0 6px #fbbf24; animation: p 1s infinite; }
    @keyframes p { 50% { opacity: .35; } }
    .grow { flex: 1; }
    .icon { background: none; border: 0; color: #9a9ba2; font-size: 14px; cursor: pointer; padding: 0 3px; line-height: 1; }
    .icon:hover { color: #fff; }
    .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; gap: 6px; align-items: center; }
    .row.small { font-size: 11px; color: #9a9ba2; }
    button.btn {
      background: #2f3138; color: #e8e8ea; border: 1px solid #3d3f47; border-radius: 6px;
      padding: 5px 9px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap;
    }
    button.btn:hover { background: #3a3d45; }
    button.btn:disabled { opacity: .4; cursor: not-allowed; }
    button.btn.primary { background: #2b6cb0; border-color: #3182ce; }
    button.btn.primary:hover { background: #3182ce; }
    input[type=text], input[type=number], textarea, select {
      background: #15161a; color: #e8e8ea; border: 1px solid #3a3c44; border-radius: 6px;
      padding: 5px 7px; font-size: 12px; font-family: inherit; width: 100%; box-sizing: border-box;
    }
    textarea { resize: vertical; min-height: 46px; }
    .stat { font-size: 12px; color: #cfd0d4; word-break: break-all; min-height: 18px; }
    .bar { height: 4px; background: #303239; border-radius: 2px; overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #2b6cb0, #4ade80); transition: width .25s; }
    .log {
      max-height: 108px; overflow: auto; background: #131418; border-radius: 6px; padding: 6px;
      font: 11px/1.5 ui-monospace, Consolas, monospace; color: #9a9ba2; user-select: text;
    }
    .log div.err { color: #f87171; }
    .log div.warn { color: #fbbf24; }
    .log div.ok { color: #4ade80; }
    .qlist { display: flex; flex-direction: column; gap: 3px; max-height: 116px; overflow: auto; }
    .qitem { display: flex; gap: 6px; align-items: center; font-size: 11px; color: #b9bac0; }
    .qitem .s { width: 46px; flex: none; }
    .qitem .u { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; }
    .qitem.done .s { color: #4ade80; }
    .qitem.running .s { color: #fbbf24; }
    .qitem.error .s { color: #f87171; }
    .qitem.stopped .s { color: #f87171; }
    .hidden { display: none !important; }
    .settings { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #303239; padding-top: 8px; }
    .settings label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #b9bac0; }
    .settings label span { flex: 1; }
    .settings input[type=number] { width: 62px; }
    .mini { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      background: #2b6cb0; color: #fff; border: 0; border-radius: 16px; padding: 6px 12px;
      font: 12px -apple-system, "Microsoft YaHei", sans-serif; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
  `;

  const STATUS_TEXT = {
    pending: '等待中',
    running: '进行中',
    done: '已完成',
    error: '出错',
    stopped: '已中断',
  };

  function buildUI() {
    if (!document.body) return null;
    const host = document.createElement('div');
    host.id = 'ehdl-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="mini" id="mini">EH 下载器</button>
      <div class="panel hidden">
        <div class="head" id="drag">
          <span class="dot" id="dot"></span><b>EH 画廊下载器</b>
          <span class="grow"></span>
          <button class="icon" id="btn-collapse">—</button>
        </div>
        <div class="body">
          <div class="row">
            <button class="btn primary" id="btn-cur">下载本画廊</button>
            <button class="btn" id="btn-queue">加入队列</button>
            <button class="btn" id="btn-go">开始队列</button>
          </div>
          <div class="stat" id="stat">就绪</div>
          <div class="bar"><i id="bar"></i></div>
          <div class="row small"><span id="meta"></span></div>
          <div class="row">
            <button class="btn" id="btn-pause">暂停</button>
            <button class="btn" id="btn-stop">停止</button>
            <button class="btn" id="btn-settings">设置</button>
            <button class="btn" id="btn-clear">清空队列</button>
          </div>
          <div class="qlist" id="qlist"></div>
          <div class="row">
            <input type="text" id="inp-urls" placeholder="粘贴画廊链接，每行一个，然后点「加入队列」">
          </div>
          <div class="row">
            <button class="btn" id="btn-page">抓取本页画廊</button>
            <button class="btn" id="btn-fav">抓取收藏夹</button>
          </div>
          <div class="settings hidden" id="settings">
            <label><span>保存方式</span>
              <select id="set-mode" style="width:120px">
                <option value="zip">打包 ZIP</option>
                <option value="folder">逐图存文件夹</option>
              </select>
            </label>
            <label><span>并发请求数</span><input type="number" id="set-conc" min="1" max="8" step="1"></label>
            <label><span>请求间隔(ms)</span><input type="number" id="set-gap" min="0" max="5000" step="100"></label>
            <label><span>附带 info.txt</span><input type="checkbox" id="set-info"></label>
            <label><span>重扫画廊页</span><input type="checkbox" id="set-rescan"></label>
            <label><span>webp 转 jpg</span><input type="checkbox" id="set-webp"></label>
          </div>
          <div class="log" id="log"></div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const panel = root.querySelector('.panel');
    const mini = $('mini');
    const dot = $('dot');
    const stat = $('stat');
    const bar = $('bar');
    const meta = $('meta');
    const logBox = $('log');
    const qlist = $('qlist');
    const settingsBox = $('settings');

    const api = {
      log(msg, level) {
        const d = document.createElement('div');
        if (level) d.className = level;
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        d.textContent = `[${t}] ${msg}`;
        logBox.appendChild(d);
        while (logBox.childElementCount > 200) logBox.removeChild(logBox.firstChild);
        logBox.scrollTop = logBox.scrollHeight;
      },
      info(msg) { stat.textContent = msg; },
      progress(evt) {
        const { phase, done = 0, total = 0, bytes = 0, eta = 0, size = 0, pages = 0, bps = 0 } = evt;
        dot.classList.toggle('busy', phase !== '空闲' && phase !== '就绪');
        if (total > 0) {
          const pct = Math.min(100, (done / total) * 100);
          bar.style.width = pct.toFixed(1) + '%';
          stat.textContent = `${phase} ${done}/${total}  ·  ${pct.toFixed(0)}%`;
          const extra = [];
          if (bytes) extra.push(fmtBytes(bytes));
          if (bps > 0) extra.push(`${fmtBytes(bps)}/s`);
          if (size) extra.push(`输出 ${fmtBytes(size)}`);
          if (eta && isFinite(eta)) extra.push(`剩余 ${fmtDuration(eta)}`);
          meta.textContent = extra.join('  ·  ');
        } else {
          bar.style.width = '0%';
          stat.textContent = phase;
          meta.textContent = pages ? `已发现 ${pages} 张` : '';
        }
        if (phase === '空闲') { bar.style.width = '0%'; meta.textContent = ''; }
      },
    };
    ui = api;

    /* ---------- 折叠 / 拖拽 ---------- */
    const showPanel = () => { mini.classList.add('hidden'); panel.classList.remove('hidden'); };
    const hidePanel = () => { panel.classList.add('hidden'); mini.classList.remove('hidden'); };
    $('btn-collapse').addEventListener('click', hidePanel);
    mini.addEventListener('click', showPanel);

    const dragHead = $('drag');
    let dragging = false;
    let dx = 0;
    let dy = 0;
    dragHead.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      dragging = true;
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 340, e.clientX - dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dy)) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    /* ---------- 设置 ---------- */
    const syncSettings = () => {
      $('set-mode').value = settings.mode;
      $('set-conc').value = settings.concurrency;
      $('set-gap').value = settings.gap;
      $('set-info').checked = !!settings.infoFile;
      $('set-rescan').checked = !!settings.rescan;
      $('set-webp').checked = settings.webpToJpg !== false;
    };
    $('btn-settings').addEventListener('click', () => {
      settingsBox.classList.toggle('hidden');
      syncSettings();
    });
    $('set-mode').addEventListener('change', (e) => { settings.mode = e.target.value; saveSettings(); });
    $('set-conc').addEventListener('change', (e) => {
      settings.concurrency = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 3));
      e.target.value = settings.concurrency;
      limiter.setRate(settings.concurrency, settings.gap);
      saveSettings();
    });
    $('set-gap').addEventListener('change', (e) => {
      settings.gap = Math.max(0, Math.min(5000, parseInt(e.target.value, 10) || 0));
      e.target.value = settings.gap;
      limiter.setRate(settings.concurrency, settings.gap);
      saveSettings();
    });
    $('set-info').addEventListener('change', (e) => { settings.infoFile = e.target.checked; saveSettings(); });
    $('set-rescan').addEventListener('change', (e) => { settings.rescan = e.target.checked; saveSettings(); });
    $('set-webp').addEventListener('change', (e) => { settings.webpToJpg = e.target.checked; saveSettings(); });

    /* ---------- 任务控制 ---------- */
    const enqueueCurrent = () => {
      const info = parseGalleryUrl(location.href);
      if (!info) { api.log('当前页面不是画廊页', 'warn'); return 0; }
      return addToQueue([info.base]);
    };

    $('btn-cur').addEventListener('click', () => {
      const info = parseGalleryUrl(location.href);
      if (!info) { api.log('当前页面不是画廊页，请先打开一个画廊', 'warn'); return; }
      addToQueue([info.base]);
      renderQueue();
      if (!queueRunning) runQueue();
    });

    $('btn-queue').addEventListener('click', enqueueCurrent);

    $('btn-go').addEventListener('click', () => {
      if (queueRunning) { api.log('队列已在运行'); return; }
      const pending = queue.filter((q) => q.status === 'pending' || q.status === 'error' || q.status === 'stopped');
      if (!pending.length) { api.log('队列为空', 'warn'); return; }
      pending.forEach((q) => { q.status = 'pending'; });
      stopQueue = false;
      runQueue();
    });

    $('btn-pause').addEventListener('click', (e) => {
      if (!currentJob) { api.log('当前没有运行中的任务', 'warn'); return; }
      currentJob.paused = !currentJob.paused;
      e.target.textContent = currentJob.paused ? '继续' : '暂停';
      api.log(currentJob.paused ? '已暂停' : '继续下载');
    });

    $('btn-stop').addEventListener('click', () => {
      if (!currentJob) { stopQueue = true; api.log('已停止队列'); return; }
      currentJob.aborted = true;
      stopQueue = true;
      api.log('正在停止…', 'warn');
    });

    $('btn-clear').addEventListener('click', () => {
      if (queueRunning) { api.log('请先停止队列', 'warn'); return; }
      queue.length = 0;
      renderQueue();
      saveQueue();
    });

    $('btn-page').addEventListener('click', () => {
      const urls = collectPageGalleries(document);
      if (!urls.length) { api.log('本页没有找到画廊链接', 'warn'); return; }
      addToQueue(urls);
    });

    $('btn-fav').addEventListener('click', async () => {
      try {
        const urls = await crawlFavorites(settings.maxFavPages);
        if (!urls.length) { api.log('收藏夹没有抓到画廊（可能未登录）', 'warn'); return; }
        addToQueue(urls);
      } catch (e) {
        api.log('抓取收藏夹失败：' + e.message, 'err');
      }
    });

    const inp = $('inp-urls');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        addToQueue(inp.value.split(/[\s,]+/));
        inp.value = '';
      }
    });
    inp.addEventListener('change', () => {
      const lines = inp.value.split(/[\s,]+/).filter(Boolean);
      if (lines.length > 1) { addToQueue(lines); inp.value = ''; }
    });

    if (parseGalleryUrl(location.href)) showPanel();

    return api;
  }

  function renderQueue() {
    const host = document.getElementById('ehdl-host');
    if (!host || !host.shadowRoot) return;
    const qlist = host.shadowRoot.getElementById('qlist');
    if (!qlist) return;
    qlist.textContent = '';
    for (const item of queue.slice(-60)) {
      const row = document.createElement('div');
      row.className = 'qitem ' + item.status;
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = STATUS_TEXT[item.status] || item.status;
      const u = document.createElement('span');
      u.className = 'u';
      u.title = item.url;
      u.textContent = item.title || item.url.replace(/^https?:\/\//, '');
      row.append(s, u);
      qlist.appendChild(row);
    }
  }

  function collectPageGalleries(doc) {
    const out = [];
    const seen = new Set();
    doc.querySelectorAll('a[href*="/g/"]').forEach((a) => {
      const info = parseGalleryUrl(a.getAttribute('href') || '');
      if (!info) return;
      if (seen.has(info.base)) return;
      seen.add(info.base);
      out.push(info.base);
    });
    return out;
  }

  async function crawlFavorites(maxPages) {
    const urls = [];
    const seen = new Set();
    let next = `${ORIGIN}/favorites.php`;
    for (let p = 0; p < maxPages; p++) {
      ui.log(`抓取收藏夹第 ${p + 1} 页…`);
      const html = await fetchText(next, { label: '收藏夹' });
      const found = collectPageGalleries(new DOMParser().parseFromString(html, 'text/html'));
      let added = 0;
      for (const u of found) {
        if (seen.has(u)) continue;
        seen.add(u);
        urls.push(u);
        added++;
      }
      if (added === 0) break;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const link = Array.from(doc.querySelectorAll('a[href]')).find((a) =>
        /favorites\.php\?next=/.test(a.getAttribute('href') || '')
      );
      if (!link) break;
      next = new URL(link.getAttribute('href'), ORIGIN).href;
    }
    return urls;
  }

  /* =========================================================================
   * 9. 启动
   * ====================================================================== */
  function boot() {
    if (typeof GM_xmlhttpRequest !== 'function') {
      console.error('[EH 下载器] 需要 Tampermonkey / Violentmonkey 环境');
      return;
    }
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    buildUI();
    if (ui) {
      ui.log(`已就绪（${isEx() ? 'ExHentai' : 'E-Hentai'}），当前模式：${settings.mode === 'zip' ? '打包 ZIP' : '逐图存文件夹'}`);
      const loggedIn = /(^|;\s*)ipb_member_id=\d+/.test(document.cookie);
      ui.log(loggedIn
        ? '检测到登录状态：优先取 /fullimg/ 的真原图'
        : '未检测到登录 cookie：只能取重采样 webp/avif（会自动转 JPG）；要原图请在当前浏览器登录 E-Hentai',
      loggedIn ? 'ok' : 'warn');
      const info = parseGalleryUrl(location.href);
      if (info) {
        const meta = document.querySelector('#gn');
        if (meta) {
          const t = meta.textContent.trim();
          if (t) ui.info(t);
        }
        // 刷新后如果这个画廊有存档，提示可以直接续传，不用重新解析
        const saved = store.get('state.' + info.gid, null);
        if (saved && saved.ver === STATE_VER) {
          const totalPages = (saved.urls || []).length || (saved.pageUrls || []).length;
          const doneN = (saved.done || []).length;
          if (totalPages && doneN < totalPages) {
            const when = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString() : '';
            ui.log(`检测到未完成存档：已下载 ${doneN}/${totalPages} 张（${when}）。点「下载本画廊」即从断点继续`, 'warn');
          }
        }
      }
      // 恢复上次没跑完的队列（只填回列表，不自动开跑，避免刷新页面就突然满速）
      const restored = restoreQueue();
      if (restored) {
        const pend = queue.filter((q) => q.status === 'pending').length;
        ui.log(`已恢复上次未完成的队列：${pend} 个画廊。点「开始队列」继续，或「清空队列」丢弃`, 'warn');
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    // node 环境（无头测试）：导出纯函数，不启动 UI
    module.exports = {
      parseGalleryUrl, parseGalleryMeta, parseThumbLinks, parseImagePage,
      sniffImage, imageKind, looksLikeHtml, crc32, ZipWriter, sanitize, extFromUrl,
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
