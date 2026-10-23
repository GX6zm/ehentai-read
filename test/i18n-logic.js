'use strict';
/**
 * 无头测试：用真实抓下来的 E-Hentai 页面验证汉化脚本。
 * 运行：node test/i18n-logic.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PROBE = process.env.EH_PROBE_DIR || path.join(process.env.TEMP || '/tmp', 'ehprobe');
let passed = 0;
function ok(cond, name, detail) {
  if (!cond) {
    console.error('FAIL: ' + name + (detail ? '  <<' + detail + '>>' : ''));
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log('ok - ' + name);
}

function loadPage(file) {
  const p = path.join(PROBE, file);
  if (!fs.existsSync(p)) return null;
  const html = fs.readFileSync(p, 'utf8');
  const dom = new JSDOM(html, { url: 'https://e-hentai.org/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.DOMParser = dom.window.DOMParser;
  global.MutationObserver = dom.window.MutationObserver;
  // 重新加载脚本以获得干净的 records 状态
  delete require.cache[require.resolve(path.join(__dirname, '..', 'ehentai-i18n.user.js'))];
  const lib = require(path.join(__dirname, '..', 'ehentai-i18n.user.js'));
  return { dom, lib, doc: dom.window.document };
}

function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.trim() : '(missing ' + sel + ')';
}

(async () => {
  /* ---------------- 画廊页 ---------------- */
  const gp = loadPage('gallery.html');
  if (gp) {
    const { lib, doc } = gp;
    const titleBefore = text('#gn');
    const tagBefore = text('#taglist td');
    const n = await lib.translateDocument();
    ok(n > 0, '画廊页：翻译了若干处', String(n));
    ok(text('#gn') === titleBefore, '画廊页：标题不被翻译', text('#gn'));
    ok(text('#taglist td') === tagBefore, '画廊页：标签不被翻译', text('#taglist td'));
    ok(doc.querySelectorAll('.gt').length > 0, '画廊页：标签节点仍在');

    const labels = Array.from(doc.querySelectorAll('#gdd td.gdt1')).map((td) => td.textContent.trim());
    ok(labels.includes('发布时间：'), '画廊页：Posted: 已汉化', labels.join('|'));
    ok(labels.includes('文件大小：'), '画廊页：File Size: 已汉化');
    ok(labels.includes('页数：'), '画廊页：Length: 已汉化');
    ok(labels.includes('收藏数：'), '画廊页：Favorited: 已汉化');
    ok(text('#grt1') === '评分：', '画廊页：Rating: 已汉化', text('#grt1'));
    ok(labels.includes('语言：'), '画廊页：Language: 已汉化');

    const body = doc.body.textContent;
    ok(body.includes('加入收藏'), '画廊页：Add to Favorites 已汉化');
    ok(body.includes('举报画廊'), '画廊页：Report Gallery 已汉化');
    ok(body.includes('归档下载'), '画廊页：Archive Download 已汉化');
    ok(/种子下载（0）/.test(body), '画廊页：Torrent Download (0) 已汉化');
    ok(/显示第 1 - 20 张，共 849 张图片/.test(body), '画廊页：Showing 1 - 20 of 849 images 已汉化');
    ok(body.includes('849 页'), '画廊页：849 pages 已汉化');
    ok(/平均：2\.57/.test(body), '画廊页：Average 已汉化');
    ok(/杂项/.test(body), '画廊页：分类 Misc 已汉化');
    ok(/日语/.test(body), '画廊页：语言 Japanese 已汉化');
    ok(!/Posted:/.test(body) || !body.includes('Posted: '), '画廊页：不再残留 Posted: 标签');

    lib.revertAll();
    ok(text('#gn') === titleBefore, '画廊页：撤销后标题不变');
    ok(text('#taglist td') === tagBefore, '画廊页：撤销后标签复原');
    ok(bodyHas(doc, 'Add to Favorites'), '画廊页：撤销后按钮文案复原');
  } else {
    console.log('skip - 缺少 gallery.html');
  }

  /* ---------------- 首页（.nbw 拆分词） ---------------- */
  const fp = loadPage('front.html');
  if (fp) {
    const { lib, doc } = fp;
    const firstTitle = text('.glink');
    await lib.translateDocument();
    const nav = Array.from(doc.querySelectorAll('#nb a')).map((a) => a.textContent.replace(/\s+/g, ' ').trim());
    ok(nav[0] === '首页', '.nbw：Front Page 整词翻译为「首页」', nav[0]);
    ok(nav.includes('收藏夹'), '.nbw：Favorites 整词翻译为「收藏夹」', nav.join('|'));
    ok(nav.includes('我的主页'), '.nbw：My Home 整词翻译为「我的主页」');
    ok(doc.body.textContent.includes('显示高级选项'), '首页：Show Advanced Options 已汉化');
    ok(doc.body.textContent.includes('排行榜'), '首页：Toplists 已汉化');
    ok(doc.body.textContent.includes('关注'), '首页：Watched 已汉化');
    ok(text('.glink') === firstTitle, '首页：作品标题不被翻译', text('.glink'));
    ok(text('.glname') === text('.glname'), '首页：上传者列不被翻译');
    ok(!/首页 页/.test(doc.body.textContent), '.nbw：没有出现「首页 页」碎片拼接');
    ok(!/收藏orite/.test(doc.body.textContent), '.nbw：没有出现「收藏orite」碎片拼接');
  } else {
    console.log('skip - 缺少 front.html');
  }

  /* ---------------- 图片详情页 ---------------- */
  const ip = loadPage('i4.html');
  if (ip) {
    const { lib, doc } = ip;
    const imgSrc = (doc.querySelector('#img') || {}).src;
    await lib.translateDocument();
    const body = doc.body.textContent;
    ok(body.includes('查找包含此图的画廊'), '图片页：Show galleries with this image 已汉化');
    ok(body.includes('获取论坛图片链接'), '图片页：Get forum image link 已汉化');
    ok(body.includes('重新加载损坏图片'), '图片页：Reload broken image 已汉化');
    ok(/下载原图 1968 x 2528 664\.7 KiB/.test(body), '图片页：Download original 已汉化且保留尺寸');
    ok((doc.querySelector('#img') || {}).src === imgSrc, '图片页：图片地址不被改写');
    ok(!/Download original/.test(body), '图片页：不残留 Download original');
  } else {
    console.log('skip - 缺少 i4.html');
  }

  /* ---------------- 纯函数 ---------------- */
  const lp = loadPage('gallery.html') || loadPage('i4.html');
  if (lp) {
    const { lib } = lp;
    ok(lib.lookup('Favorites') === '收藏夹', 'lookup：词典命中');
    ok(lib.lookup('Totally Not A UI String 12345') === null, 'lookup：未知文案返回 null');
    ok(lib.lookup('477.5 MiB') === null, 'lookup：容量不翻译');
    ok(lib.lookup('1 - 20') === null, 'lookup：纯数字不翻译');
    ok(lib.lookup('2026-10-23 02:58') === null, 'lookup：日期不翻译');
    ok(lib.lookup('11 comments') === '11 条评论', 'lookup：评论数模式');
    ok(lib.lookup('Showing 1 - 20 of 446 images') === '显示第 1 - 20 张，共 446 张图片', 'lookup：列表统计模式');
    ok(lib.lookup('Posted on 12 October 2026, 12:00 by:') === '发表于 2026年10月12日 12:00，作者：', 'lookup：发布时间模式', String(lib.lookup('Posted on 12 October 2026, 12:00 by:')));
    ok(lib.md5('abc') === '900150983cd24fb0d6963f7d28e17f72', 'md5 与标准向量一致', lib.md5('abc'));
    ok(lib.translatable('Kermixx') && !lib.isExcluded(document.createElement('div')), 'translatable/isExcluded 基础行为');
    const div = document.createElement('div');
    div.innerHTML = '<div id="gn"><span>Title</span></div>';
    ok(lib.isExcluded(div.querySelector('span')) === true, 'isExcluded 命中 #gn 内部节点');
  }

  console.log('\n' + passed + ' 项通过' + (process.exitCode ? '，存在失败项' : ''));
})();

function bodyHas(doc, s) { return doc.body.textContent.includes(s); }
