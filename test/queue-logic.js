/**
 * 队列持久化测试：在 jsdom 里真实跑 userscript（模拟 GM_* 存储），
 * 验证「加入队列 → 关页面 → 重开 → 队列自动恢复 → 清空后不再恢复」。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const SCRIPT = path.join(__dirname, '..', 'ehentai-downloader.user.js');
const GALLERY = 'https://e-hentai.org/g/4274759/c1040ff0d5/';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
};

/** GM 存储：跨「页面重开」共享同一个 Map，模拟 Tampermonkey */
const makeStorage = () => new Map();

async function loadPage(storage, url, { login = true } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="gn">[omar-0097] test gallery</div><p>正文</p></body></html>',
    { url, pretendToBeVisual: true }
  );
  const w = dom.window;
  if (login) {
    Object.defineProperty(w.document, 'cookie', {
      get: () => 'ipb_member_id=12345; ipb_pass_hash=abc',
      configurable: true,
    });
  }
  const sandbox = {
    window: w,
    document: w.document,
    location: w.location,
    navigator: w.navigator,
    console,
    setTimeout: w.setTimeout.bind(w),
    clearTimeout: w.clearTimeout.bind(w),
    setInterval: w.setInterval.bind(w),
    clearInterval: w.clearInterval.bind(w),
    requestAnimationFrame: (fn) => w.setTimeout(fn, 16),
    cancelAnimationFrame: (id) => w.clearTimeout(id),
    Blob: w.Blob,
    URL: w.URL,
    TextEncoder,
    TextDecoder,
    GM_setValue: (k, v) => storage.set(k, v),
    GM_getValue: (k, d) => (storage.has(k) ? storage.get(k) : d),
    GM_deleteValue: (k) => storage.delete(k),
    GM_xmlhttpRequest: () => { throw new Error('测试不应发起网络请求'); },
    module: undefined,
    exports: undefined,
    require: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'ehentai-downloader.user.js' });
  // userscript 在 DOMContentLoaded 里启动，等 UI 挂上
  await new Promise((r) => setTimeout(r, 80));
  return w;
}

const sr = (w) => w.document.getElementById('ehdl-host').shadowRoot;
const logText = (w) => sr(w).querySelector('#log').textContent;
const qText = (w) => sr(w).querySelector('#qlist').textContent;
const qCount = (w) => sr(w).querySelectorAll('#qlist .qitem').length;

(async () => {
  console.log('[1] 首次进入画廊页：UI 启动 + 队列存档初始化');
  const storage = makeStorage();
  let w = await loadPage(storage, GALLERY);
  t('面板已挂载', !!w.document.getElementById('ehdl-host'));
  t('启动日志含登录状态', logText(w).includes('检测到登录状态'), logText(w));
  const initQ = storage.get('ehdl.v1.queue');
  t('初始无队列存档（懒写入）', initQ === undefined || (Array.isArray(initQ) && initQ.length === 0), String(initQ));

  console.log('[2] 加入队列 → 写入 GM 存储');
  sr(w).querySelector('#btn-queue').dispatchEvent(new w.Event('click'));
  const saved = storage.get('ehdl.v1.queue');
  t('存档有 1 项', Array.isArray(saved) && saved.length === 1, JSON.stringify(saved));
  t('存档项是画廊地址', !!saved && saved[0].url === GALLERY, saved && saved[0].url);
  t('存档状态归一为 pending', !!saved && saved[0].status === 'pending', saved && saved[0].status);
  t('队列列表显示该画廊', qText(w).includes('4274759'), qText(w));

  console.log('[3] 模拟关页面重开：队列自动恢复');
  w = await loadPage(storage, 'https://e-hentai.org/');
  t('恢复日志出现', logText(w).includes('已恢复上次未完成的队列'), logText(w));
  t('恢复后队列列表 1 项', qCount(w) === 1, String(qCount(w)));
  t('恢复后为等待状态（不自动开跑）', qText(w).includes('等待'), qText(w));

  console.log('[4] 再开一次不会重复添加');
  w = await loadPage(storage, GALLERY);
  t('队列仍是 1 项', qCount(w) === 1, String(qCount(w)));
  t('存档仍是 1 项', storage.get('ehdl.v1.queue').length === 1, String(storage.get('ehdl.v1.queue').length));

  console.log('[5] 清空队列 → 存档清空 → 重开不再恢复');
  sr(w).querySelector('#btn-clear').dispatchEvent(new w.Event('click'));
  t('清空后存档为空数组', JSON.stringify(storage.get('ehdl.v1.queue')) === '[]', String(storage.get('ehdl.v1.queue')));
  w = await loadPage(storage, 'https://e-hentai.org/');
  t('重开无恢复日志', !logText(w).includes('已恢复上次未完成的队列'), logText(w));
  t('重开队列为空', qCount(w) === 0, String(qCount(w)));

  console.log('[6] 存档里的无效地址被忽略');
  storage.set('ehdl.v1.queue', [{ url: 'https://example.com/not-a-gallery' }, { url: GALLERY }]);
  w = await loadPage(storage, 'https://e-hentai.org/');
  t('只恢复合法画廊', qCount(w) === 1, String(qCount(w)));

  console.log('[7] 存档结构损坏时不崩');
  storage.set('ehdl.v1.queue', { broken: true });
  try {
    w = await loadPage(storage, 'https://e-hentai.org/');
    t('坏存档时仍能启动', !!w.document.getElementById('ehdl-host'));
  } catch (e) {
    t('坏存档时仍能启动', false, e.message);
  }

  console.log(`\n${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
