package com.astranova.voice;

/**
 * ตัวแปลงเสียงแบบปรับค่าได้ + ตัดเสียงรบกวนแบบแรง — ต้องตรงกับ www/vfx.js
 * สูตรเสียงมาจากเซิร์ฟเวอร์ (server/voices.js) เป็นอาร์เรย์ 23 ค่า
 */
final class VoiceFx {
    private static final int RATE = 16000, EL = 8000;
    private static final double TAU = 2 * Math.PI;
    private static double co(double f) { return Math.exp(-TAU * f / RATE); }
    private static final double DN_HP = co(120), LOWC = co(900);

    /** ตัวเปลี่ยนระดับเสียงแบบหน้าต่างหน่วงเวลา 2 หัวอ่าน */
    private static final class Shifter {
        private static final int N = 4096, W = 1200;
        private final float[] buf = new float[N];
        private int w = 0;
        private double ph = 0;
        private double tap(double p) {
            double pos = w - (p * W + 1);
            while (pos < 0) pos += N;
            int i = (int) Math.floor(pos);
            double f = pos - i;
            float a = buf[i % N], b = buf[(i + 1) % N];
            return a + (b - a) * f;
        }
        double run(double x, double r) {
            buf[w] = (float) x;
            ph += (1 - r) / W;
            ph -= Math.floor(ph);
            double p2 = (ph + 0.5) % 1.0;
            double s1 = Math.sin(Math.PI * ph), s2 = Math.sin(Math.PI * p2);
            double y = tap(ph) * s1 * s1 + tap(p2) * s2 * s2;
            w = (w + 1) % N;
            return y;
        }
    }

    /** ฟิลเตอร์ biquad (สูตร RBJ) — type: 0 lowpass, 1 highpass, 2 bandpass */
    private static final class Biquad {
        double b0 = 1, b1, b2, a1, a2, x1, x2, y1, y2;
        void set(int type, double f, double q) {
            f = Math.min(Math.max(f, 20), RATE * 0.45);
            double w0 = TAU * f / RATE, c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
            double n0, n1, n2;
            if (type == 0) { n0 = (1 - c) / 2; n1 = 1 - c; n2 = (1 - c) / 2; }
            else if (type == 1) { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = (1 + c) / 2; }
            else { n0 = al; n1 = 0; n2 = -al; }
            double a0 = 1 + al;
            b0 = n0 / a0; b1 = n1 / a0; b2 = n2 / a0; a1 = (-2 * c) / a0; a2 = (1 - al) / a0;
        }
        double run(double x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            return y;
        }
    }

    private final Shifter sh1 = new Shifter(), sh2 = new Shifter();
    private final Biquad hpF = new Biquad(), lpF = new Biquad(), pkF = new Biquad();
    private final float[] eb = new float[EL];
    private int ew = 0, hold = 0;
    private long rnd = 12345;
    private double vibPh = 0, ringPh = 0, tremPh = 0, low = 0, env = 0, held = 0;
    private double dnY = 0, dnX = 0, dnG = 1;
    private float[] P = null;

    private void load(float[] fx) {
        if (P != null && java.util.Arrays.equals(P, fx)) return;
        P = fx.clone();
        if (P[7] > 0) hpF.set(1, P[7], 0.707);
        if (P[8] > 0) lpF.set(0, P[8], 0.707);
        if (P[9] > 0) pkF.set(2, P[9], 1.5);
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

    /** fx = อาร์เรย์ 23 ค่าจากเซิร์ฟเวอร์ (null = ไม่เปลี่ยนเสียง) */
    void process(short[] pcm, int n, float[] fx) {
        if (fx == null || fx.length < 23) return;
        load(fx);
        final double pitch = P[0], vibRate = P[1], vibDepth = P[2], dbl = P[3], dblMix = P[4], ringHz = P[5], ringMix = P[6],
            hp = P[7], lp = P[8], peakHz = P[9], peakGain = P[10], drive = P[11], bits = P[12], down = P[13],
            tremRate = P[14], tremDepth = P[15], echoMs = P[16], echoFb = P[17], echoMix = P[18], noise = P[19],
            gain = P[20], bass = P[21], treble = P[22];
        int ed = (int) Math.min(EL - 1, Math.max(1, Math.round(echoMs * RATE / 1000)));
        double q = bits > 0 ? Math.pow(2, bits - 1) : 0;
        int dn = (int) Math.max(1, Math.round(down));
        double dTanh = drive > 0 ? Math.tanh(drive) : 1;
        for (int i = 0; i < n; i++) {
            double x = pcm[i] / 32768.0;
            // 1) ระดับเสียง + เสียงสั่น
            double r = pitch;
            if (vibRate > 0) { vibPh += vibRate / RATE; vibPh -= Math.floor(vibPh); r *= 1 + vibDepth * Math.sin(TAU * vibPh); }
            final double dry = x;
            if (r != 1) x = sh1.run(x, r);
            // 2) เสียงที่สองซ้อน
            if (dbl > 0) x = x * (1 - dblMix * 0.5) + sh2.run(dry, dbl) * dblMix;
            // 3) ทุ้ม/แหลม
            if (bass != 1 || treble != 1) { low += (1 - LOWC) * (x - low); x = low * bass + (x - low) * treble; }
            // 4) ตัดย่านเสียง + เน้นย่าน
            if (hp > 0) x = hpF.run(x);
            if (lp > 0) x = lpF.run(x);
            if (peakHz > 0) x += pkF.run(x) * peakGain;
            // 5) หุ่นยนต์
            if (ringHz > 0) { ringPh += ringHz / RATE; ringPh -= Math.floor(ringPh); x = x * (1 - ringMix) + x * Math.sin(TAU * ringPh) * ringMix * 1.4; }
            // 6) เสียงแตก + ลดคุณภาพ
            if (drive > 0) x = Math.tanh(x * drive) / dTanh;
            if (q > 0) x = Math.round(x * q) / q;
            if (dn > 1) { if (hold <= 0) { held = x; hold = dn; } hold--; x = held; }
            // 7) เสียงขาดๆ หายๆ
            if (tremRate > 0) { tremPh += tremRate / RATE; tremPh -= Math.floor(tremPh); x *= 1 - tremDepth * 0.5 * (1 - Math.sin(TAU * tremPh)); }
            // 8) เสียงลม/กระซิบ ตามความดังของเสียงพูด
            if (noise > 0) {
                double a = Math.abs(dry); env += (a > env ? 0.05 : 0.002) * (a - env);
                rnd = (rnd * 1103515245L + 12345L) & 0x7fffffffL;
                x += noise * env * 3 * (rnd / (double) 0x3fffffff - 1);
            }
            // 9) เสียงก้อง
            if (echoMs > 0) {
                int rp = ew - ed; if (rp < 0) rp += EL;
                double d = eb[rp];
                eb[ew] = (float) (x + echoFb * d);
                ew = (ew + 1) % EL;
                x = x + echoMix * d;
            }
            x *= gain;
            long v = Math.round(x * 32767);
            pcm[i] = (short) (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
    }
}
