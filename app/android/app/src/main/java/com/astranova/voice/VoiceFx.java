package com.astranova.voice;

/** ตัวเปลี่ยนเสียง (แอดมิน) — ต้องตรงกับ www/vfx.js */
final class VoiceFx {
    private static final int RATE = 16000, N = 4096, W = 1200, EL = 3200;
    private static final float[] PITCH = {1f, 0.7f, 1.6f, 1f, 0.58f, 1f, 1f, 1.3f};
    private static final double HP = Math.exp(-2 * Math.PI * 400 / RATE), LP = Math.exp(-2 * Math.PI * 2800 / RATE);
    private final float[] buf = new float[N];
    private final float[] eb = new float[EL];
    private int w = 0, ew = 0, t = 0;
    private double ph = 0, hpY = 0, hpX = 0, lp = 0;

    private float tap(double p) {
        double pos = w - (p * W + 1);
        while (pos < 0) pos += N;
        int i = (int) Math.floor(pos);
        double f = pos - i;
        float a = buf[i % N], b = buf[(i + 1) % N];
        return (float) (a + (b - a) * f);
    }

    private float pitch(float x, float r) {
        buf[w] = x;
        ph += (1 - r) / W;
        ph -= Math.floor(ph);
        double p2 = (ph + 0.5) % 1.0;
        double s1 = Math.sin(Math.PI * ph), s2 = Math.sin(Math.PI * p2);
        float y = (float) (tap(ph) * s1 * s1 + tap(p2) * s2 * s2);
        w = (w + 1) % N;
        return y;
    }

    void process(short[] pcm, int n, int id) {
        if (id <= 0 || id >= PITCH.length) return;
        float r = PITCH[id];
        for (int i = 0; i < n; i++) {
            float x = pcm[i] / 32768f;
            if (r != 1f) x = pitch(x, r);
            switch (id) {
                case 3: x = (float) (x * Math.sin(2 * Math.PI * 55 * t / RATE) * 1.6); break;
                case 4: x = (float) (Math.tanh(x * 1.8) * 0.8); break;
                case 5:
                    hpY = HP * (hpY + x - hpX); hpX = x;
                    lp = lp + (1 - LP) * (hpY - lp);
                    x = (float) (Math.tanh(lp * 4) * 0.6); break;
                case 6: { float d = eb[ew]; float y = x + 0.5f * d; eb[ew] = x + 0.4f * d; ew = (ew + 1) % EL; x = y * 0.8f; break; }
                default: break;
            }
            t = (t + 1) % RATE;
            int v = Math.round(x * 32767);
            pcm[i] = (short) (v > 32767 ? 32767 : Math.max(v, -32768));
        }
    }
}
