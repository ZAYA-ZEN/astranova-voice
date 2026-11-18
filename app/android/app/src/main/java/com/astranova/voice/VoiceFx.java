package com.astranova.voice;

/** ตัวเปลี่ยนเสียง (แอดมิน) + ตัดเสียงรบกวนแบบแรง — ต้องตรงกับ www/vfx.js */
final class VoiceFx {
    private static final int RATE = 16000, N = 4096, W = 1200, EL = 3200;
    private static final float[] PITCH = {1f, 0.7f, 1.6f, 1f, 0.58f, 1f, 1f, 1.3f, 1f, 1.25f, 1.15f, 0.75f, 1f};
    private static double co(double f) { return Math.exp(-2 * Math.PI * f / RATE); }
    private static final double HP5 = co(400), LP5 = co(2800), HP8 = co(500), LP8 = co(2500), HP12 = co(600), LP12 = co(3500), DN_HP = co(120);
    private final float[] buf = new float[N];
    private final float[] eb = new float[EL];
    private int w = 0, ew = 0, t = 0;
    private double ph = 0, hpY = 0, hpX = 0, lp = 0, dnY = 0, dnX = 0, dnG = 1;

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

    private double band(double x, double ha, double la) {
        hpY = ha * (hpY + x - hpX); hpX = x;
        lp = lp + (1 - la) * (hpY - lp);
        return lp;
    }

    private float echo(float x, float fb) {
        float d = eb[ew]; float y = x + 0.5f * d; eb[ew] = x + fb * d; ew = (ew + 1) % EL; return y;
    }

    /** ตัดเสียงรบกวนแบบแรง: ตัดเสียงหึ่งต่ำกว่า 120Hz + กดเสียงเบาๆ ระหว่างคำพูด */
    void denoise(short[] pcm, int n) {
        double sq = 0;
        for (int i = 0; i < n; i++) {
            double x = pcm[i] / 32768.0;
            dnY = DN_HP * (dnY + x - dnX); dnX = x;
            sq += dnY * dnY;
            long v = Math.round(dnY * 32767);
            pcm[i] = (short) Math.max(-32768, Math.min(32767, v));
        }
        double rms = Math.sqrt(sq / n), T = 0.02;
        double target = rms >= T ? 1 : Math.pow(rms / T, 2);
        double step = (target - dnG) / n;
        for (int i = 0; i < n; i++) { dnG += step; pcm[i] = (short) Math.round(pcm[i] * dnG); }
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
                case 5: x = (float) (Math.tanh(band(x, HP5, LP5) * 4) * 0.6); break;
                case 6: x = echo(x, 0.4f) * 0.8f; break;
                case 8: x = (float) (band(x, HP8, LP8) * 1.4); break;
                case 9: x = (float) (x * (0.55 + 0.45 * Math.sin(2 * Math.PI * 30 * t / RATE)) * 1.2); break;
                case 10: x = (float) (echo(x, 0.55f) * 0.7 * (0.85 + 0.15 * Math.sin(2 * Math.PI * 5 * t / RATE))); break;
                case 11: x = (float) (Math.tanh(x * 3) * 0.6); break;
                case 12: x = (float) (Math.tanh(band(x, HP12, LP12) * 5) * 0.5); break;
                default: break;
            }
            t = (t + 1) % RATE;
            int v = Math.round(x * 32767);
            pcm[i] = (short) (v > 32767 ? 32767 : Math.max(v, -32768));
        }
    }
}
