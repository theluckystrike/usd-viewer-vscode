'use strict';
// Decompressors for the USDC (crate) file format, written from the format description:
// - LZ4 block decoding and the chunked wrapper USD puts around it (a count byte, then int32-sized chunks).
// - USD's integer compression: a common value, 2-bit codes per integer and a stream of 8/16/32 (or 16/32/64) bit
//   deltas. Each decoded integer is the running sum of the deltas.
// And the matching encoders used by the Pro converter when it writes USDC: LZ4 with literal-only blocks (valid LZ4
// that every decoder reads) and the same integer coding.

/** Decodes one raw LZ4 block from src[start, end) into dst starting at dstPos; returns the new dstPos. */
function lz4Block(src, start, end, dst, dstPos) {
  let i = start;
  let o = dstPos;
  while (i < end) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255 && i < end); }
    if (i + lit > end || o + lit > dst.length) throw new Error('LZ4 data is damaged (literal run past the end).');
    dst.set(src.subarray(i, i + lit), o);
    i += lit; o += lit;
    if (i >= end) break; // the last sequence has literals only
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    if (off === 0 || off > o) throw new Error('LZ4 data is damaged (bad match offset).');
    let len = token & 15;
    if (len === 15) { let b; do { b = src[i++]; len += b; } while (b === 255 && i < end); }
    len += 4;
    if (o + len > dst.length) throw new Error('LZ4 data is damaged (match past the end).');
    let m = o - off;
    if (off >= len) { dst.copyWithin(o, m, m + len); o += len; } else { for (let k = 0; k < len; k++) dst[o++] = dst[m++]; }
  }
  return o;
}

/** USD's chunked LZ4 ("TfFastCompression"): returns a Uint8Array of at most maxOut bytes. */
function fastDecompress(src, maxOut) {
  if (!src.length) return new Uint8Array(0);
  const dst = new Uint8Array(maxOut);
  const chunks = src[0];
  let o = 0;
  if (chunks === 0) {
    o = lz4Block(src, 1, src.length, dst, 0);
  } else {
    let i = 1;
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let c = 0; c < chunks; c++) {
      const size = dv.getInt32(i, true);
      i += 4;
      if (size < 0 || i + size > src.length) throw new Error('LZ4 chunk size is damaged.');
      o = lz4Block(src, i, i + size, dst, o);
      i += size;
    }
  }
  return o === maxOut ? dst : dst.subarray(0, o);
}

/** Decodes `count` integers from USD integer coding (after LZ4). wide: 64-bit variant (returns BigInt-free Numbers). */
function decodeInts(buf, count, wide) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = wide ? new Float64Array(count) : new Int32Array(count);
  let p = 0;
  let common;
  if (wide) { common = Number(dv.getBigInt64(0, true)); p = 8; } else { common = dv.getInt32(0, true); p = 4; }
  const codesStart = p;
  let v = codesStart + ((count * 2 + 7) >> 3);
  let prev = 0;
  for (let n = 0; n < count; n++) {
    const code = (buf[codesStart + (n >> 2)] >> ((n & 3) * 2)) & 3;
    let d;
    if (code === 0) d = common;
    else if (wide) {
      if (code === 1) { d = dv.getInt16(v, true); v += 2; } else if (code === 2) { d = dv.getInt32(v, true); v += 4; } else { d = Number(dv.getBigInt64(v, true)); v += 8; }
    } else if (code === 1) { d = dv.getInt8(v); v += 1; } else if (code === 2) { d = dv.getInt16(v, true); v += 2; } else { d = dv.getInt32(v, true); v += 4; }
    prev = wide ? prev + d : (prev + d) | 0;
    out[n] = prev;
  }
  return out;
}

/** Working buffer size USD reserves for `count` coded integers (an upper bound). */
function intsBound(count, wide) {
  const w = wide ? 8 : 4;
  return w + ((count * 2 + 7) >> 3) + count * w;
}

// ---------- encoders (for writing USDC) ----------

/** LZ4 block with literals only. */
function lz4Literal(src) {
  const parts = [];
  let len = src.length;
  if (len >= 15) {
    parts.push(0xf0);
    len -= 15;
    while (len >= 255) { parts.push(255); len -= 255; }
    parts.push(len);
  } else parts.push(len << 4);
  const out = new Uint8Array(parts.length + src.length);
  out.set(parts, 0);
  out.set(src, parts.length);
  return out;
}

/** USD chunked wrapper: 0 chunks + one LZ4 block (inputs here stay far below the 2 GB chunk limit). */
function fastCompress(src) {
  const block = lz4Literal(src);
  const out = new Uint8Array(block.length + 1);
  out[0] = 0;
  out.set(block, 1);
  return out;
}

/** USD integer coding of an array of 32-bit (or 64-bit when wide) signed integers. */
function encodeInts(values, wide) {
  const n = values.length;
  const deltas = new Array(n);
  let prev = 0;
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const v = Number(values[i]);
    const d = wide ? v - prev : (v - prev) | 0;
    deltas[i] = d;
    prev = v;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let common = 0, best = -1;
  for (const [d, c] of counts) if (c > best || (c === best && d < common)) { best = c; common = d; }
  const w = wide ? 8 : 4;
  const codesLen = (n * 2 + 7) >> 3;
  const buf = new Uint8Array(w + codesLen + n * w);
  const dv = new DataView(buf.buffer);
  if (wide) dv.setBigInt64(0, BigInt(common), true); else dv.setInt32(0, common, true);
  let v = w + codesLen;
  for (let i = 0; i < n; i++) {
    const d = deltas[i];
    let code;
    if (d === common) code = 0;
    else if (wide) {
      if (d >= -32768 && d <= 32767) { code = 1; dv.setInt16(v, d, true); v += 2; } else if (d >= -2147483648 && d <= 2147483647) { code = 2; dv.setInt32(v, d, true); v += 4; } else { code = 3; dv.setBigInt64(v, BigInt(d), true); v += 8; }
    } else if (d >= -128 && d <= 127) { code = 1; dv.setInt8(v, d); v += 1; } else if (d >= -32768 && d <= 32767) { code = 2; dv.setInt16(v, d, true); v += 2; } else { code = 3; dv.setInt32(v, d, true); v += 4; }
    buf[w + (i >> 2)] |= code << ((i & 3) * 2);
  }
  return buf.subarray(0, v);
}

module.exports = { lz4Block, fastDecompress, decodeInts, intsBound, lz4Literal, fastCompress, encodeInts };
