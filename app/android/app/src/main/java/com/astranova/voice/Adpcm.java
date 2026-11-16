package com.astranova.voice;

/** IMA-ADPCM แบบเดียวกับ www/codec.js: [ค่าแรก int16 LE][index u8][nibble...] */
public final class Adpcm {
    private static final int[] IT = { -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8 };
    private static final int[] ST = { 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767 };
    private int encIdx = 0;

    private static int clamp(int v) { return v > 32767 ? 32767 : (v < -32768 ? -32768 : v); }

    public byte[] encode(short[] pcm, int n) {
        byte[] out = new byte[3 + (n >> 1)];
        int pred = pcm[0], idx = encIdx;
        out[0] = (byte) pred; out[1] = (byte) (pred >> 8); out[2] = (byte) idx;
        for (int i = 1; i < n; i++) {
            int step = ST[idx], diff = pcm[i] - pred, sign = 0;
            if (diff < 0) { sign = 8; diff = -diff; }
            int nib = 0, vp = step >> 3;
            if (diff >= step) { nib = 4; diff -= step; vp += step; }
            step >>= 1; if (diff >= step) { nib |= 2; diff -= step; vp += step; }
            step >>= 1; if (diff >= step) { nib |= 1; vp += step; }
            pred = clamp(sign != 0 ? pred - vp : pred + vp);
            nib |= sign;
            idx += IT[nib]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
            int j = i - 1, b = 3 + (j >> 1);
            if ((j & 1) != 0) out[b] |= (byte) (nib << 4); else out[b] = (byte) nib;
        }
        encIdx = idx;
        return out;
    }

    public static short[] decode(byte[] in, int off, int len, int n) {
        short[] out = new short[n];
        int pred = (short) ((in[off] & 255) | (in[off + 1] << 8)), idx = Math.min(88, in[off + 2] & 255);
        out[0] = (short) pred;
        for (int i = 1; i < n; i++) {
            int j = i - 1, bi = 3 + (j >> 1);
            if (bi >= len) break;
            int b = in[off + bi] & 255;
            int nib = (j & 1) != 0 ? b >> 4 : b & 15;
            int step = ST[idx], vp = step >> 3;
            if ((nib & 4) != 0) vp += step;
            if ((nib & 2) != 0) vp += step >> 1;
            if ((nib & 1) != 0) vp += step >> 2;
            pred = clamp((nib & 8) != 0 ? pred - vp : pred + vp);
            out[i] = (short) pred;
            idx += IT[nib]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
        }
        return out;
    }
}
