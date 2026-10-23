'use strict';
/**
 * 无头测试：用真实抓下来的 E-Hentai 页面验证下载器的解析逻辑。
 * 运行：node test/download-logic.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const PROBE = process.env.EH_PROBE_DIR || path.join(process.env.TEMP || '/tmp', 'ehprobe');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://e-hentai.org/g/4274759/c1040ff0d5/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.DOMParser = dom.window.DOMParser;
global.URL = dom.window.URL;

const lib = require(path.join(__dirname, '..', 'ehentai-downloader.user.js'));

let passed = 0;
function ok(cond, name, detail) {
  if (!cond) {
    console.error('FAIL: ' + name + (detail ? '\n  ' + detail : ''));
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log('ok - ' + name);
}
function page(name) {
  const p = path.join(PROBE, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/* ---------- 1. 画廊 URL 解析 ---------- */
const g = lib.parseGalleryUrl('https://e-hentai.org/g/4274759/c1040ff0d5/?p=2');
ok(g && g.gid === '4274759' && g.token === 'c1040ff0d5', 'parseGalleryUrl 提取 gid/token');
ok(lib.parseGalleryUrl('https://exhentai.org/g/123/abcdef/') !== null, 'parseGalleryUrl 支持 exhentai');
ok(lib.parseGalleryUrl('https://e-hentai.org/favorites.php') === null, 'parseGalleryUrl 拒绝非画廊链接');

/* ---------- 2. 画廊页元数据 ---------- */
const galleryHtml = page('gallery.html');
if (galleryHtml) {
  const meta = lib.parseGalleryMeta(galleryHtml);
  ok(meta.title.length > 0, 'parseGalleryMeta 抓到标题', JSON.stringify(meta.title));
  ok(meta.title.indexOf(' - E-Hentai') === -1, 'parseGalleryMeta 去掉站点后缀', meta.title);
  ok(parseInt(meta.rows['Length'], 10) === 849, 'parseGalleryMeta 读取 Length=849', JSON.stringify(meta.rows));
  ok(meta.rows['File Size'] === '477.5 MiB', 'parseGalleryMeta 读取文件大小', meta.rows['File Size']);
  ok(meta.tags.length >= 3, 'parseGalleryMeta 抓到标签', String(meta.tags.length));
  ok(meta.tags.some((t) => t.indexOf(':') > 0), 'parseGalleryMeta 标签带命名空间前缀');
  ok(!meta.tags.includes('+'), 'parseGalleryMeta 过滤掉 "+"');
  ok(meta.length === 849, 'parseGalleryMeta 返回 length 数字');

  const thumbs = lib.parseThumbLinks(galleryHtml, 'https://e-hentai.org/g/4274759/c1040ff0d5/');
  ok(thumbs.length === 20, 'parseThumbLinks 取到 20 个图片页链接', String(thumbs.length));
  ok(thumbs.every((u) => /\/s\/[0-9a-z]{6,}\/\d+-\d+/.test(u)), 'parseThumbLinks 全部是 /s/ 图片页');
  ok(thumbs[0] === 'https://e-hentai.org/s/089d7b1f72/4274759-1', 'parseThumbLinks 还原绝对地址', thumbs[0]);
  ok(new Set(thumbs).size === thumbs.length, 'parseThumbLinks 去重');
} else {
  console.log('skip - 缺少 gallery.html 样本');
}

/* ---------- 3. 图片页：原图地址必须指向图片本身 ---------- */
const imgWithOriginal = page('i4.html');   // 有 Download original 的页面
if (imgWithOriginal) {
  const r = lib.parseImagePage(imgWithOriginal);
  ok(r.candidates.length >= 1, 'parseImagePage 至少给出一个候选');
  ok(/\/fullimg\//.test(r.candidates[0]), 'parseImagePage 优先使用 fullimg 原图', r.candidates[0]);
  ok(/\.jpg$/i.test(r.candidates[0].split('?')[0]), 'parseImagePage 原图地址是 jpg');
  ok(r.src === r.candidates[0], 'parseImagePage src 与首选候选一致');
  ok(!/f_shash=/.test(r.candidates.join(' ')), 'parseImagePage 绝不把搜索链接当原图', r.candidates.join(' '));
  ok(/^https:\/\//.test(r.candidates[0]) && !r.candidates[0].startsWith('//'), 'parseImagePage 返回绝对 URL');
} else {
  console.log('skip - 缺少 i4.html 样本');
}

const imgNoOriginal = page('image.html');  // xres=org 直接是原图
if (imgNoOriginal) {
  const r = lib.parseImagePage(imgNoOriginal);
  ok(r.candidates.length >= 1, 'parseImagePage(xres=org) 有候选');
  ok(/hath\.network/.test(r.candidates[0]), 'parseImagePage(xres=org) 取 #img 的图片主机', r.candidates[0]);
  ok(!/f_shash=/.test(r.candidates[0]), 'parseImagePage(xres=org) 不是搜索链接');
  ok(/xres=org/.test(r.candidates[0]), 'parseImagePage(xres=org) 保留原图参数');
} else {
  console.log('skip - 缺少 image.html 样本');
}

/* ---------- 4. 图片文件头嗅探 ---------- */
function bytes(arr) { return new Uint8Array(arr).buffer; }
ok(lib.sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === true, 'sniffImage 识别 JPEG');
ok(lib.sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === true, 'sniffImage 识别 PNG');
ok(lib.sniffImage(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])) === true, 'sniffImage 识别 GIF');
const webp = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
ok(lib.sniffImage(bytes(webp)) === true, 'sniffImage 识别 WEBP');
ok(lib.sniffImage(bytes([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 0x20, 0x68, 0x74])) === false, 'sniffImage 拒绝 HTML');
ok(lib.sniffImage(new ArrayBuffer(0)) === false, 'sniffImage 拒绝空数据');

/* ---------- 4.5 真实字节决定扩展名（修复“webp 存成 .jpg”） ---------- */
ok(lib.imageKind(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'jpg', 'imageKind 返回 jpg');
ok(lib.imageKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === 'png', 'imageKind 返回 png');
ok(lib.imageKind(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])) === 'gif', 'imageKind 返回 gif');
ok(lib.imageKind(bytes([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === 'webp', 'imageKind 返回 webp');
ok(lib.imageKind(bytes([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) === 'avif', 'imageKind 返回 avif');
ok(lib.imageKind(bytes([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54])) === '', 'imageKind 对 HTML 返回空');
ok(lib.looksLikeHtml(new TextEncoder().encode('<!DOCTYPE html><html><body>bounce_login.php</body></html>').buffer) === true, 'looksLikeHtml 识别 HTML 头');
ok(lib.looksLikeHtml(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === false, 'looksLikeHtml 不误判 JPEG');

// 用真实下载回来的字节验证：hath.network 给的是 webp，而 fullimg 的 URL 后缀是 .jpg
const realWebp = path.join(PROBE, 'dl2.bin');
if (fs.existsSync(realWebp)) {
  const b = fs.readFileSync(realWebp);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  ok(lib.imageKind(ab) === 'webp', '真实 hath 响应是 webp');
  ok(lib.extFromUrl('https://e-hentai.org/fullimg/1/2/3/name.jpg') === 'jpg', 'fullimg 的 URL 后缀仍是 jpg（旧逻辑会错标扩展名）');
}
const bounce = path.join(PROBE, 'dl1.bin');
if (fs.existsSync(bounce)) {
  const b = fs.readFileSync(bounce);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  ok(lib.looksLikeHtml(ab) === true, '未登录时 /fullimg/ 返回的 bounce_login 页被识别为 HTML');
}


/* ---------- 5. 文件名与路径 ---------- */
ok(lib.extFromUrl('https://x/y/001.JPG') === 'jpg', 'extFromUrl 小写化');
ok(lib.extFromUrl('https://e-hentai.org/fullimg/1/2/3/name.jpg') === 'jpg', 'extFromUrl 处理 fullimg');
ok(lib.sanitize('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j', 'sanitize 去掉非法字符');

/* ---------- 6. CRC32 / ZIP ---------- */
ok(lib.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'crc32 与标准向量一致');
ok(lib.crc32(new TextEncoder().encode('')) === 0, 'crc32 空数据为 0');

(async () => {
  const chunks = [];
  const zw = new lib.ZipWriter((bytes) => { chunks.push(bytes); });
  await zw.add('a.txt', new TextEncoder().encode('hello'));
  await zw.add('sub/b.txt', new TextEncoder().encode('world'));
  await zw.finish();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  ok(total > 100, 'ZipWriter 产出非空字节流', String(total));
  const eocd = chunks[chunks.length - 1];
  ok(new DataView(eocd.buffer, eocd.byteOffset, 4).getUint32(0, true) === 0x06054b50, 'ZipWriter 以 EOCD 结尾');
  ok(new DataView(eocd.buffer, eocd.byteOffset).getUint16(10, true) === 2, 'ZipWriter 中央目录记录 2 个条目');

  const out = path.join(process.env.TEMP || '/tmp', 'ehzip-test.zip');
  fs.writeFileSync(out, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  console.log('zip written: ' + out);

  console.log('\n' + passed + ' 项通过' + (process.exitCode ? '，存在失败项' : ''));
})();
