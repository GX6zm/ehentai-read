'use strict';
/**
 * 修复旧版下载器写出的 ZIP：所有条目的 CRC 字段被写成 0（数据本身是完整的）。
 * WinRAR / 7-Zip / Bandizip 校验 CRC 时会报错，甚至拒绝解压。
 *
 * 用法：node tools/fix-zip-crc.js "<原 zip>" ["<输出 zip>"]
 * 只改头部的 CRC 字段（STORE 模式，数据不需要移动），不碰文件内容。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 复用下载器里的 crc32 实现
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://e-hentai.org/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.DOMParser = dom.window.DOMParser;
global.URL = dom.window.URL;
const lib = require(path.join(__dirname, '..', 'ehentai-downloader.user.js'));

const src = process.argv[2];
if (!src) { console.error('用法: node tools/fix-zip-crc.js <原 zip> [输出 zip]'); process.exit(1); }
const dst = process.argv[3] || src.replace(/\.zip$/i, '') + ' (修复).zip';

const buf = fs.readFileSync(src);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const u16 = (o) => dv.getUint16(o, true);
const u32 = (o) => dv.getUint32(o, true);
const w32 = (o, v) => dv.setUint32(o, v >>> 0, true);

let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
  if (u32(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('找不到 EOCD，文件可能被截断，无法修复'); process.exit(1); }

const total = u16(eocd + 10);
let p = u32(eocd + 16);
let fixed = 0, same = 0, bad = 0;
for (let i = 0; i < total; i++) {
  if (u32(p) !== 0x02014b50) { console.error('中央目录损坏 @' + p); process.exit(1); }
  const method = u16(p + 10);
  const csize = u32(p + 24); // STORE 模式下压缩大小 == 原始大小
  const nlen = u16(p + 28);
  const elen = u16(p + 30);
  const clen = u16(p + 32);
  const lho = u32(p + 42);
  const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
  if (u32(lho) !== 0x04034b50) { console.error(name + '：本地头损坏'); bad++; p += 46 + nlen + elen + clen; continue; }
  const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
  if (method !== 0) {
    console.warn(name + '：压缩方式不是 STORE（' + method + '），跳过');
    bad++;
  } else if (dataStart + csize > buf.length) {
    console.warn(name + '：数据超出文件末尾，跳过');
    bad++;
  } else {
    const real = lib.crc32(buf.subarray(dataStart, dataStart + csize));
    if (u32(p + 16) !== real) { w32(p + 16, real); w32(lho + 14, real); fixed++; }
    else same++;
  }
  p += 46 + nlen + elen + clen;
}

fs.writeFileSync(dst, buf);
console.log('条目 ' + total + '：修正 CRC ' + fixed + ' 条，本来就对 ' + same + ' 条，跳过 ' + bad + ' 条');
console.log('输出：' + dst);
