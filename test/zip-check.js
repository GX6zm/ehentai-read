'use strict';
/* 体检一个 ZIP：EOCD / 中央目录 / 每个条目的本地头、大小、CRC32 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 脚本在加载期就会读 location / document，用 jsdom 给个无害的环境
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://e-hentai.org/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.DOMParser = dom.window.DOMParser;
global.URL = dom.window.URL;

const lib = require(path.join(__dirname, '..', 'ehentai-downloader.user.js'));

const file = process.argv[2];
if (!file) { console.error('用法: node test/zip-check.js <zip 路径>'); process.exit(1); }
const buf = fs.readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

function u16(o) { return dv.getUint16(o, true); }
function u32(o) { return dv.getUint32(o, true); }

// EOCD 从尾部往前找
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
  if (u32(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('找不到 EOCD，文件被截断？'); process.exit(1); }

const total = u16(eocd + 10);
const cdSize = u32(eocd + 12);
const cdOff = u32(eocd + 16);
const commentLen = u16(eocd + 20);
console.log('文件大小     ' + buf.length);
console.log('EOCD 位置    ' + eocd + '（尾部注释 ' + commentLen + ' 字节）');
console.log('条目数       ' + total);
console.log('中央目录     offset=' + cdOff + ' size=' + cdSize + ' 结束于 ' + (cdOff + cdSize) + (cdOff + cdSize === eocd ? ' ✔ 紧贴 EOCD' : ' ✘ 与 EOCD 之间有空隙'));

let p = cdOff;
let bad = 0, zero = 0, firstBad = null;
const problems = [];
for (let i = 0; i < total; i++) {
  if (u32(p) !== 0x02014b50) { problems.push('第 ' + (i + 1) + ' 条中央目录签名错误 @' + p); break; }
  const flags = u16(p + 8);
  const method = u16(p + 10);
  const crc = u32(p + 16);
  const csize = u32(p + 20);
  const usize = u32(p + 24);
  const nlen = u16(p + 28);
  const elen = u16(p + 30);
  const clen = u16(p + 32);
  const lho = u32(p + 42);
  const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');

  // 本地头一致性
  if (u32(lho) !== 0x04034b50) { problems.push(name + '：本地头签名错 @' + lho); }
  else {
    const lflags = u16(lho + 6);
    const lmethod = u16(lho + 8);
    const lnlen = u16(lho + 26);
    const lelen = u16(lho + 28);
    const lname = buf.slice(lho + 30, lho + 30 + lnlen).toString('utf8');
    if (lname !== name) problems.push(name + '：本地头文件名不一致（' + lname + '）');
    if (lmethod !== method) problems.push(name + '：压缩方式不一致');
    if (lflags !== flags) problems.push(name + '：通用标志位不一致');
    if ((flags & 0x08)) problems.push(name + '：用了 data descriptor（Windows 资源管理器对此较挑剔）');
    const lcrc = u32(lho + 14);
    if (lcrc !== crc) problems.push(name + '：本地头 CRC(' + lcrc.toString(16) + ') 与中央目录(' + crc.toString(16) + ') 不一致');
    const dataStart = lho + 30 + lnlen + lelen;
    if (dataStart + csize > buf.length) problems.push(name + '：数据超出文件末尾（截断）');
    if (csize === 0 || usize === 0) zero++;
    if (csize !== usize) problems.push(name + '：STORE 模式下压缩大小≠原始大小');
    // CRC 校验（STORE 模式直接算原始数据）
    if (method === 0 && dataStart + csize <= buf.length) {
      const got = lib.crc32(buf.subarray(dataStart, dataStart + csize)) >>> 0;
      if (got !== crc) { bad++; if (!firstBad) firstBad = { name, crc, got }; }
    }
  }
  if (i < 3 || i >= total - 2) {
    console.log(`  #${i + 1} ${name}  method=${method} size=${usize} crc=${crc.toString(16)} lho=${lho}`);
  }
  p += 46 + nlen + elen + clen;
}
if (p !== cdOff + cdSize) problems.push('中央目录遍历长度不符：' + p + ' vs ' + (cdOff + cdSize));

console.log('\nCRC 错误   ' + bad + ' 条' + (firstBad ? '（首个：' + firstBad.name + ' 期望 ' + firstBad.crc.toString(16) + ' 实际 ' + firstBad.got.toString(16) + '）' : ' ✔'));
console.log('空条目     ' + zero + ' 条');
console.log('结构问题   ' + problems.length + ' 条');
problems.slice(0, 20).forEach((s) => console.log('  - ' + s));
process.exitCode = (bad || problems.length) ? 1 : 0;
