/**
 * 流水线测试：jsdom 里真实跑 userscript，网络全部打桩。
 * 验证「解析一页 → 立刻下载」的流水线行为：并发受限、解析与下载重叠、20 页全部写入、无失败。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SCRIPT = path.join(__dirname, '..', 'ehentai-downloader.user.js');
const GALLERY = 'https://e-hentai.org/g/1111/abcdef/';
const PAGES = 20;
const LATENCY = 25;   // 每个请求的假延迟，用来让并发/流水线显形

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
};

/* ---------- 打桩的站点数据 ---------- */
const hash = (n) => 'a1b2c3' + String(n).padStart(2, '0');
const galleryHtml = (p) => {
  const head = '<div id="gn">Test Gallery</div><div id="gdd"><table><tr><td class="gdt1">Length:</td><td class="gdt2">20</td></tr></table></div>';
  if (Number(p) > 0) return head; // 第二页起没有缩略图 → 扫描结束
  let html = head + '<div id="gdt">';
  for (let n = 1; n <= PAGES; n++) {
    html += `<a href="https://e-hentai.org/s/${hash(n)}/1111-${n}"><div title="Page ${n}: ${String(n).padStart(3, '0')}.jpg"></div></a>`;
  }
  return html + '</div>';
};
const imagePageHtml = (n) => `<div id="i1"><img id="img" src="https://aa.hath.network/h/${hash(n)}-1/${String(n).padStart(3, '0')}.jpg"></div>`;
const jpegBytes = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, n & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xd9]).buffer;

const stats = { inflight: 0, maxInflight: 0, seq: 0, firstImgSeq: 0, lastPageSeq: 0, pageReqs: 0, imgReqs: 0 };

/* ---------- jsdom + vm 加载真实脚本 ---------- */
async function main() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {}); // 忽略 a.download 点击造成的 navigation 警告
  const dom = new JSDOM('<!doctype html><html><body><div id="gn">Test Gallery</div></body></html>',
    { url: GALLERY, pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  Object.defineProperty(w.document, 'cookie', {
    get: () => 'ipb_member_id=12345; ipb_pass_hash=abc',
    configurable: true,
  });

  const storage = new Map();
  storage.set('ehdl.v1.settings', {
    mode: 'zip', concurrency: 6, gap: 0, infoFile: false, rescan: false,
    maxFavPages: 20, autoStart: true, webpToJpg: true,
  });

  const finish = (seq) => { stats.inflight--; return seq; };
  const again = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));

  const textResponse = async (url) => {
    stats.pageReqs++;
    const u = new URL(url);
    const seq = ++stats.seq;
    if (u.pathname.startsWith('/s/')) stats.lastPageSeq = seq;
    await again(LATENCY, () => 0);
    stats.inflight--;
    let body;
    if (u.pathname.startsWith('/s/')) {
      const n = parseInt(u.pathname.split('/').pop().split('-').pop(), 10);
      body = imagePageHtml(n);
    } else {
      body = galleryHtml(u.searchParams.get('p') || '0');
    }
    return {
      status: 200, ok: true,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      text: async () => body,
    };
  };

  function start() {
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    return ++stats.seq;
  }

  const sandbox = {
    window: w, document: w.document, location: w.location, navigator: w.navigator,
    console, Blob: w.Blob, URL: w.URL, DOMParser: w.DOMParser, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array,
    setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w),
    setInterval: w.setInterval.bind(w), clearInterval: w.clearInterval.bind(w),
    requestAnimationFrame: (fn) => w.setTimeout(fn, 16), cancelAnimationFrame: (id) => w.clearTimeout(id),
    fetch: (url) => { start(); return textResponse(url); },
    GM_setValue: (k, v) => storage.set(k, v),
    GM_getValue: (k, d) => (storage.has(k) ? storage.get(k) : d),
    GM_deleteValue: (k) => storage.delete(k),
    GM_xmlhttpRequest: (opts) => {
      const seq = start();
      if (!stats.firstImgSeq) stats.firstImgSeq = seq;
      stats.imgReqs++;
      const m = String(opts.url).match(/(\d+)\.jpg/);
      if (process.env.PIPE_DEBUG) console.log('    [gm] ' + opts.url + ' -> ' + (m ? m[1] : 'NO-MATCH'));
      setTimeout(() => {
        const n = m ? parseInt(m[1], 10) : 1;
        stats.inflight--;
        opts.onload({ status: 200, response: jpegBytes(n) });
      }, LATENCY);
    },
    module: undefined, exports: undefined, require: undefined,
  };
  sandbox.globalThis = sandbox;

  /* 拦截下载：替换 URL.createObjectURL（保留 URL 构造函数，脚本内部要用 new URL） */
  let blob = null;
  w.URL.createObjectURL = (b) => { blob = b; return 'blob:fake'; };
  w.URL.revokeObjectURL = () => {};

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'ehentai-downloader.user.js' });
  await new Promise((r) => setTimeout(r, 100));

  const sr = w.document.getElementById('ehdl-host').shadowRoot;
  const log = () => sr.querySelector('#log').textContent;

  t('面板已挂载', !!sr);
  sr.querySelector('#btn-cur').dispatchEvent(new w.Event('click'));

  const deadline = Date.now() + 60000;
  while (!blob && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));

  console.log('  · 请求数：图片页 ' + stats.pageReqs + '，图片 ' + stats.imgReqs + '，最大并发 ' + stats.maxInflight);
  t('生成了 ZIP blob', !!blob, log().slice(0, 300));
  t('20 页图片全部写入（jpg ×20）', /jpg ×20/.test(log()), log().slice(-400));
  t('日志里没有失败', !/失败/.test(log()), log().slice(-400));
  t('图片页 20 次 + 画廊页 2 次', stats.pageReqs === 22, String(stats.pageReqs));
  t('图片请求 20 次', stats.imgReqs === PAGES, String(stats.imgReqs));
  t('并发受 settings 限制（≤6）', stats.maxInflight <= 6, String(stats.maxInflight));
  t('确实并行了（≥2）', stats.maxInflight >= 2, String(stats.maxInflight));
  t('流水线：图片下载早于最后一个图片页解析', stats.firstImgSeq < stats.lastPageSeq,
    `firstImg=${stats.firstImgSeq} lastPage=${stats.lastPageSeq}`);

  console.log(`\n${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
