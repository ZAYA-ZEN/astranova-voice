// ตัวบีบอัดเสียง IMA-ADPCM (เล็กลง 4 เท่า) — โค้ดเดียวกับฝั่ง Android/iOS
// เฟรมละ 640 ตัวอย่าง (40ms @16kHz): [ค่าแรก int16][index u8][639 nibble] = 323 ไบต์
"use strict";
(function (g) {
  const IT = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  const ST = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

  function Encoder() { this.idx = 0; }
  // pcm: Int16Array → Uint8Array
  Encoder.prototype.encode = function (pcm) {
    const n = pcm.length, out = new Uint8Array(3 + ((n - 1 + 1) >> 1));
    let pred = pcm[0], idx = this.idx;
    out[0] = pred & 255; out[1] = (pred >> 8) & 255; out[2] = idx;
    for (let i = 1; i < n; i++) {
      let step = ST[idx], diff = pcm[i] - pred, sign = 0;
      if (diff < 0) { sign = 8; diff = -diff; }
      let nib = 0, vp = step >> 3;
      if (diff >= step) { nib = 4; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { nib |= 2; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { nib |= 1; vp += step; }
      pred = clamp16(sign ? pred - vp : pred + vp);
      nib |= sign;
      idx += IT[nib]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
      const j = i - 1, b = 3 + (j >> 1);
      if (j & 1) out[b] |= nib << 4; else out[b] = nib;
    }
    this.idx = idx;
    return out;
  };

  // bytes: Uint8Array → Int16Array (n ตัวอย่าง)
  function adpcmDecode(bytes, n) {
    n = n || 1 + (bytes.length - 3) * 2;
    const out = new Int16Array(n);
    let pred = (bytes[0] | (bytes[1] << 8)) << 16 >> 16, idx = Math.min(88, bytes[2]);
    out[0] = pred;
    for (let i = 1; i < n; i++) {
      const j = i - 1, b = bytes[3 + (j >> 1)];
      if (b === undefined) break;
      const nib = j & 1 ? b >> 4 : b & 15;
      const step = ST[idx];
      let vp = step >> 3;
      if (nib & 4) vp += step;
      if (nib & 2) vp += step >> 1;
      if (nib & 1) vp += step >> 2;
      pred = clamp16(nib & 8 ? pred - vp : pred + vp);
      out[i] = pred;
      idx += IT[nib]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
    }
    return out;
  }

  // Opus: ห่อหลายแพ็กเก็ตในข้อความเดียว [จำนวน u8]([ยาว u16][ข้อมูล])...
  function packOpus(packets) {
    let len = 1; for (const p of packets) len += 2 + p.length;
    const out = new Uint8Array(len); let o = 1; out[0] = packets.length;
    for (const p of packets) { out[o] = p.length & 255; out[o + 1] = p.length >> 8; out.set(p, o + 2); o += 2 + p.length; }
    return out;
  }
  function unpackOpus(bytes) {
    const n = bytes[0], list = []; let o = 1;
    for (let i = 0; i < n && o + 2 <= bytes.length; i++) {
      const l = bytes[o] | (bytes[o + 1] << 8); o += 2;
      list.push(bytes.subarray(o, o + l)); o += l;
    }
    return list;
  }

  g.AstraCodec = { Encoder, adpcmDecode, packOpus, unpackOpus, PCM: 0, ADPCM: 1, OPUS: 2 };
})(typeof window !== "undefined" ? window : globalThis);
