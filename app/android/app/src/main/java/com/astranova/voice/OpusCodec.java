package com.astranova.voice;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/** Opus ด้วย MediaCodec ของเครื่อง (เข้ารหัสได้ Android 10+, ถอดรหัสได้ทุกเครื่อง) พร้อมทดสอบตัวเองก่อนใช้ */
public final class OpusCodec {
    private static final String TAG = "AstraOpus";
    static final int RATE = 16000;
    private static Boolean encOk, decOk;

    // ---------------- Encoder ----------------
    public static final class Enc {
        private final MediaCodec mc;
        private long pts = 0;
        public Enc() throws Exception {
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 1);
            f.setInteger(MediaFormat.KEY_BIT_RATE, 24000);
            mc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            mc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            mc.start();
        }
        /** ป้อน PCM แล้วคืนแพ็กเก็ตที่ออกมาแล้ว (อาจว่าง หรือมีหลายอัน) */
        public List<byte[]> encode(short[] pcm, int n) {
            List<byte[]> out = new ArrayList<>();
            int in = mc.dequeueInputBuffer(10000);
            if (in >= 0) {
                ByteBuffer b = mc.getInputBuffer(in);
                b.clear(); b.order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < n; i++) b.putShort(pcm[i]);
                mc.queueInputBuffer(in, 0, n * 2, pts, 0);
                pts += n * 1000000L / RATE;
            }
            drain(out);
            return out;
        }
        private void drain(List<byte[]> out) {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (true) {
                int o = mc.dequeueOutputBuffer(info, 0);
                if (o < 0) break;
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    ByteBuffer b = mc.getOutputBuffer(o);
                    byte[] p = new byte[info.size];
                    b.position(info.offset); b.get(p);
                    out.add(p);
                }
                mc.releaseOutputBuffer(o, false);
            }
        }
        public void release() { try { mc.stop(); } catch (Exception ignored) {} mc.release(); }
    }

    // ---------------- Decoder ----------------
    public static final class Dec {
        private final MediaCodec mc;
        private int outRate = 48000;
        private long pts = 0;
        private double rpos = 0;
        public Dec() throws Exception {
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, 1);
            ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
            head.put("OpusHead".getBytes()); head.put((byte) 1); head.put((byte) 1);
            head.putShort((short) 0); head.putInt(RATE); head.putShort((short) 0); head.put((byte) 0);
            head.flip();
            f.setByteBuffer("csd-0", head);
            f.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0, 0));
            f.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0, 80000000L));
            mc = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            mc.configure(f, null, null, 0);
            mc.start();
        }
        /** ถอดรหัสแพ็กเก็ต คืน PCM ที่ 16kHz (อาจว่างถ้ายังไม่ออก) */
        public short[] decode(byte[] pkt, int off, int len) {
            int in = mc.dequeueInputBuffer(5000);
            if (in >= 0) {
                ByteBuffer b = mc.getInputBuffer(in);
                b.clear(); b.put(pkt, off, len);
                mc.queueInputBuffer(in, 0, len, pts, 0);
                pts += 20000;
            }
            ByteArrayOutputStream acc = new ByteArrayOutputStream();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            for (int tries = 0; tries < 3; tries++) {
                int o = mc.dequeueOutputBuffer(info, tries == 0 ? 3000 : 0);
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = mc.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) outRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    continue;
                }
                if (o < 0) break;
                if (info.size > 0) {
                    ByteBuffer b = mc.getOutputBuffer(o);
                    byte[] raw = new byte[info.size];
                    b.position(info.offset); b.get(raw);
                    acc.write(raw, 0, raw.length);
                }
                mc.releaseOutputBuffer(o, false);
                tries = -1; // มีข้อมูล → ลองดึงต่อ
                if (acc.size() > 48000) break;
            }
            byte[] raw = acc.toByteArray();
            int n = raw.length / 2;
            if (n == 0) return new short[0];
            short[] s = new short[n];
            ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s);
            if (outRate == RATE) return s;
            // ย่อ sample rate เป็น 16kHz (เฉลี่ยช่วง)
            double ratio = (double) outRate / RATE;
            int m = (int) ((n - rpos) / ratio);
            short[] r = new short[Math.max(0, m)];
            for (int i = 0; i < m; i++) {
                int a = (int) (rpos + i * ratio), e = Math.min(n, (int) (rpos + (i + 1) * ratio));
                int sum = 0, c = 0;
                for (int k = a; k < e; k++) { sum += s[k]; c++; }
                r[i] = (short) (c > 0 ? sum / c : 0);
            }
            rpos = (rpos + m * ratio) - n;
            if (rpos < 0) rpos = 0;
            return r;
        }
        public void release() { try { mc.stop(); } catch (Exception ignored) {} mc.release(); }
    }

    /** ทดสอบว่าเครื่องนี้เข้า/ถอดรหัส Opus ได้จริง */
    public static synchronized void selfTest() {
        if (encOk != null) return;
        encOk = false; decOk = false;
        Dec d = null;
        try {
            d = new Dec();
            // แพ็กเก็ตเงียบมาตรฐานของ Opus (20ms) — ถอดได้ = ตัวถอดรหัสใช้ได้จริง
            byte[] silence = { (byte) 0xF8, (byte) 0xFF, (byte) 0xFE };
            int got = 0;
            for (int i = 0; i < 6 && got == 0; i++) got += d.decode(silence, 0, 3).length;
            decOk = got > 0;
            if (!decOk) { d.release(); d = null; Log.w(TAG, "opus decoder produced no audio"); }
        } catch (Throwable t) { Log.w(TAG, "no opus decoder: " + t); d = null; }
        if (Build.VERSION.SDK_INT < 29 || d == null) { if (d != null) d.release(); return; }
        Enc e = null;
        try {
            e = new Enc();
            short[] pcm = new short[640];
            int got = 0;
            for (int f = 0; f < 8 && got == 0; f++) {
                for (int i = 0; i < 640; i++) pcm[i] = (short) (8000 * Math.sin(2 * Math.PI * 440 * (f * 640 + i) / RATE));
                for (byte[] p : e.encode(pcm, 640)) got += d.decode(p, 0, p.length).length;
                Thread.sleep(5);
            }
            encOk = got > 0;
            if (!encOk) Log.w(TAG, "opus self-test produced no audio");
        } catch (Throwable t) {
            Log.w(TAG, "no opus encoder: " + t);
        } finally {
            if (e != null) e.release();
            d.release();
        }
    }
    public static boolean canEncode() { selfTest(); return encOk; }
    public static boolean canDecode() { selfTest(); return decOk; }
}
