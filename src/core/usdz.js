'use strict';
// USDZ packages: a zip archive whose first file is the root layer (.usda, .usdc or .usd). The spec asks for stored
// (uncompressed) entries whose data starts on a 64-byte boundary; this reader also opens deflated entries (with a
// warning) so a slightly wrong package still shows. Only the central directory is trusted for names and sizes.
const zlib = require('zlib');

const MAX_ENTRIES = 100000;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

function isZip(buf) { return buf && buf.length >= 22 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4; }

/** Lists the entries: [{ name, method, size, csize, dataOffset, aligned, crc }]. */
function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 5 && buf[i + 3] === 6) { eocd = i; break; }
  if (eocd < 0) throw new Error('This USDZ file is not a complete zip archive (no end of central directory).');
  let count = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);
  // zip64 end of central directory locator
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(buf, eocd - 20) === 0x07064b50) {
    const z = Number(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(eocd - 20 + 8, true));
    if (u32(buf, z) === 0x06064b50) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      count = Number(dv.getBigUint64(z + 32, true));
      cdOffset = Number(dv.getBigUint64(z + 48, true));
    }
  }
  if (count > MAX_ENTRIES) throw new Error(`This USDZ file lists ${count} files, more than this viewer opens.`);
  const out = [];
  let p = cdOffset;
  const td = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new Error('The USDZ central directory is damaged.');
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    let csize = u32(buf, p + 20), size = u32(buf, p + 24);
    const nlen = u16(buf, p + 28), xlen = u16(buf, p + 30), clen = u16(buf, p + 32);
    let local = u32(buf, p + 42);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nlen));
    // zip64 extra field
    let x = p + 46 + nlen;
    const xe = x + xlen;
    while (x + 4 <= xe) {
      const id = u16(buf, x), len = u16(buf, x + 2);
      if (id === 1) {
        const dv = new DataView(buf.buffer, buf.byteOffset + x + 4, len);
        let k = 0;
        if (size === 0xffffffff && k + 8 <= len) { size = Number(dv.getBigUint64(k, true)); k += 8; }
        if (csize === 0xffffffff && k + 8 <= len) { csize = Number(dv.getBigUint64(k, true)); k += 8; }
        if (local === 0xffffffff && k + 8 <= len) { local = Number(dv.getBigUint64(k, true)); k += 8; }
      }
      x += 4 + len;
    }
    p = xe + clen;
    if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) throw new Error(`The USDZ entry "${name}" points outside the file.`);
    const dataOffset = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    if (dataOffset + csize > buf.length) throw new Error(`The USDZ entry "${name}" runs past the end of the file.`);
    if (name.endsWith('/')) continue;
    out.push({ name, method, size, csize, dataOffset, aligned: dataOffset % 64 === 0, crc });
  }
  return out;
}

/** The bytes of one entry (a view into buf for stored entries). */
function readEntry(buf, e, maxBytes = 2 ** 31) {
  const raw = buf.subarray(e.dataOffset, e.dataOffset + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) {
    if (e.size > maxBytes) throw new Error(`"${e.name}" is ${e.size} bytes unpacked, more than this viewer opens.`);
    return new Uint8Array(zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }));
  }
  throw new Error(`"${e.name}" uses zip compression method ${e.method}, which USDZ does not allow.`);
}

const LAYER_RE = /\.(usda|usdc|usd)$/i;

/** Opens a USDZ: { entries, rootName, read(name) }. The root layer is the first usd* entry (the spec: the first file). */
function openUsdz(buf) {
  const entries = listZip(buf);
  const root = entries.find((e) => LAYER_RE.test(e.name));
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    rootName: root ? root.name : '',
    firstIsLayer: !!(entries[0] && LAYER_RE.test(entries[0].name)),
    has: (name) => byName.has(name),
    read: (name) => { const e = byName.get(name); if (!e) throw new Error(`"${name}" is not in this USDZ package.`); return readEntry(buf, e); },
  };
}

module.exports = { isZip, listZip, readEntry, openUsdz, LAYER_RE };
