package com.astranova.voice;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSObject;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** ตัวจัดการเสียง+การเชื่อมต่อ ทำงานใน foreground service จึงใช้งานเบื้องหลังได้ */
public class VoiceEngine {
    private static final String TAG = "AstraVoice";
    static final int RATE = 16000, FRAME = 640; // 40ms

    public interface Listener { void onEvent(JSObject ev); }

    private static VoiceEngine inst;
    public static synchronized VoiceEngine get() { if (inst == null) inst = new VoiceEngine(); return inst; }

    public volatile Listener listener;
    private final OkHttpClient http = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile WebSocket ws;
    private volatile String url, hello;
    private volatile boolean want = false, open = false;

    // ค่าจาก UI
    public volatile boolean active = false, muted = false, deaf = false, ptt = false, pttDown = false;
    public volatile float threshold = 0.02f, boost = 1f, vol = 1f;
    public volatile boolean echoGate = true;
    private volatile float remoteLvl = 0;
    private volatile long remoteUntil = 0;
    private AudioManager am;

    // เสียง
    private AudioRecord rec;
    private AudioTrack track;
    private AcousticEchoCanceler aec;
    private NoiseSuppressor ns;
    private Thread capT, mixT;
    private volatile boolean running = false;
    private final ConcurrentHashMap<Integer, Spk> spk = new ConcurrentHashMap<>();

    static class Spk {
        final ConcurrentLinkedQueue<short[]> q = new ConcurrentLinkedQueue<>();
        volatile float gain = 0, pan = 0;
        float cg = -1, cp = 0;
        boolean primed = false;
        volatile long last = 0;
    }

    void emit(JSObject ev) { Listener l = listener; if (l != null) try { l.onEvent(ev); } catch (Exception ignored) {} }
    void emit(String type) { JSObject o = new JSObject(); o.put("type", type); emit(o); }
    public boolean isOpen() { return open; }

    // ---------------- WebSocket ----------------
    public synchronized void connect(String url, String hello) {
        this.url = url; this.hello = hello; want = true;
        WebSocket old = ws; ws = null;
        if (old != null) old.cancel();
        openWs();
    }

    private synchronized void openWs() {
        if (!want) return;
        Request r;
        try { r = new Request.Builder().url(url).build(); }
        catch (Exception e) { JSObject o = new JSObject(); o.put("type", "error"); o.put("message", "ที่อยู่ไม่ถูกต้อง"); emit(o); emit("close"); return; }
        ws = http.newWebSocket(r, new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response resp) {
                if (w != ws) return;
                open = true; w.send(hello); emit("open");
            }
            @Override public void onMessage(WebSocket w, String text) {
                if (w != ws) return;
                JSObject o = new JSObject(); o.put("type", "msg"); o.put("data", text); emit(o);
            }
            @Override public void onMessage(WebSocket w, ByteString bytes) {
                if (w != ws) return;
                onAudio(bytes.toByteArray());
            }
            @Override public void onClosed(WebSocket w, int code, String reason) { dropped(w); }
            @Override public void onFailure(WebSocket w, Throwable t, Response resp) { dropped(w); }
        });
    }

    private void dropped(WebSocket w) {
        if (w != ws) return;
        open = false; emit("close");
        if (want) main.postDelayed(() -> { if (want && !open) openWs(); }, 2000);
    }

    public void send(String text) { WebSocket w = ws; if (w != null && open) w.send(text); }

    public synchronized void close() {
        want = false; open = false;
        WebSocket w = ws; ws = null;
        if (w != null) w.close(1000, null);
    }

    // ---------------- Audio ----------------
    public synchronized void startAudio(Context ctx) {
        if (running) return;
        // โหมดสื่อสาร (แบบ Discord/โทร) → ระบบตัดเสียงสะท้อนของเครื่องทำงานเต็มที่
        am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        try { am.setMode(AudioManager.MODE_IN_COMMUNICATION); routeOutput(); } catch (Exception ignored) {}
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 2 * 4));
            if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(rec.getAudioSessionId()); if (aec != null) aec.setEnabled(true); }
            if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(rec.getAudioSessionId()); if (ns != null) ns.setEnabled(true); }
            rec.startRecording();
        } catch (SecurityException e) {
            JSObject o = new JSObject(); o.put("type", "error"); o.put("message", "ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน"); emit(o);
            return;
        }
        int outMin = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(outMin, FRAME * 4 * 3))
                .setTransferMode(AudioTrack.MODE_STREAM).build();
        track.play();
        running = true;
        capT = new Thread(this::captureLoop, "astra-capture"); capT.start();
        mixT = new Thread(this::mixLoop, "astra-mix"); mixT.start();
        Log.i(TAG, "audio started");
    }

    public synchronized void stopAudio() {
        if (!running) return;
        running = false;
        try { if (rec != null) rec.stop(); } catch (Exception ignored) {}
        try { if (capT != null) capT.join(500); if (mixT != null) mixT.join(500); } catch (InterruptedException ignored) {}
        try { if (rec != null) rec.release(); } catch (Exception ignored) {}
        try { if (track != null) { track.stop(); track.release(); } } catch (Exception ignored) {}
        if (aec != null) aec.release();
        if (ns != null) ns.release();
        rec = null; track = null; aec = null; ns = null;
        spk.clear();
        try {
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice(); else am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {}
    }

    /** มีหูฟัง → ออกหูฟัง, ไม่มี → ออกลำโพงใหญ่ (ไม่ใช่ลำโพงสนทนาเบาๆ) */
    @SuppressWarnings("deprecation")
    private void routeOutput() {
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo pick = null, speaker = null;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                int t = d.getType();
                if (t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) speaker = d;
                else if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                        || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                        || t == AudioDeviceInfo.TYPE_BLE_HEADSET) { if (pick == null) pick = d; }
            }
            if (pick == null) pick = speaker;
            if (pick != null) am.setCommunicationDevice(pick);
        } else {
            boolean headset = am.isWiredHeadsetOn() || am.isBluetoothScoOn() || am.isBluetoothA2dpOn();
            am.setSpeakerphoneOn(!headset);
        }
    }

    public boolean isRunning() { return running; }

    private void captureLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        short[] buf = new short[FRAME];
        short[] prev = null;
        long hang = 0, lastLevel = 0;
        boolean tx = false;
        while (running) {
            int n = 0;
            while (n < FRAME && running) {
                int r = rec.read(buf, n, FRAME - n);
                if (r <= 0) { SystemClock.sleep(5); break; }
                n += r;
            }
            if (n < FRAME) continue;
            double sum = 0;
            float b = boost;
            for (int i = 0; i < FRAME; i++) {
                int v = (int) (buf[i] * b);
                if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
                buf[i] = (short) v;
                double f = v / 32768.0; sum += f * f;
            }
            float rms = (float) Math.sqrt(sum / FRAME);
            boolean t = false;
            long now = SystemClock.uptimeMillis();
            if (active && !muted && open) {
                if (ptt) t = pttDown;
                else {
                    float th = threshold;
                    // กันเสียงสะท้อน: ขณะได้ยินคนอื่น ต้องพูดดังกว่าเสียงที่ย้อนเข้าไมค์
                    if (echoGate && now < remoteUntil) th = Math.max(th * 3f, remoteLvl * 0.6f);
                    if (rms > th) hang = now + 450;
                    t = now < hang;
                }
            }
            if (t) { if (!tx && prev != null && !ptt) sendPcm(prev); sendPcm(buf); }
            tx = t;
            prev = buf.clone();
            if (now - lastLevel > 100) {
                lastLevel = now;
                JSObject o = new JSObject(); o.put("type", "level"); o.put("rms", rms); o.put("tx", t); emit(o);
            }
        }
    }

    private void sendPcm(short[] s) {
        WebSocket w = ws;
        if (w == null) return;
        byte[] b = new byte[s.length * 2];
        for (int i = 0; i < s.length; i++) { b[2 * i] = (byte) s[i]; b[2 * i + 1] = (byte) (s[i] >> 8); }
        w.send(ByteString.of(b));
    }

    private void onAudio(byte[] d) {
        if (deaf || d.length < 6) return;
        int slot = (d[0] & 255) | ((d[1] & 255) << 8);
        float gain = (d[2] & 255) / 255f, pan = d[3] / 127f;
        int n = (d.length - 4) / 2;
        short[] s = new short[n];
        for (int i = 0; i < n; i++) s[i] = (short) ((d[4 + 2 * i] & 255) | (d[5 + 2 * i] << 8));
        Spk sp = spk.get(slot);
        if (sp == null) { sp = new Spk(); spk.put(slot, sp); }
        sp.gain = gain; sp.pan = pan; sp.last = SystemClock.uptimeMillis();
        sp.q.add(s);
        if (sp.q.size() > 10) while (sp.q.size() > 3) sp.q.poll(); // ดีเลย์สะสม → ตัดทิ้ง
    }

    private void mixLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        float[] L = new float[FRAME], R = new float[FRAME];
        short[] out = new short[FRAME * 2];
        while (running) {
            java.util.Arrays.fill(L, 0); java.util.Arrays.fill(R, 0);
            long now = SystemClock.uptimeMillis();
            for (java.util.Map.Entry<Integer, Spk> e : spk.entrySet()) {
                Spk s = e.getValue();
                if (now - s.last > 10000) { spk.remove(e.getKey()); continue; }
                if (!s.primed) { if (s.q.size() >= 2) s.primed = true; else continue; }
                short[] f = s.q.poll();
                if (f == null) { s.primed = false; continue; }
                if (s.cg < 0) { s.cg = s.gain; s.cp = s.pan; }
                int len = Math.min(f.length, FRAME);
                for (int i = 0; i < len; i++) {
                    s.cg += (s.gain - s.cg) * 0.003f;
                    s.cp += (s.pan - s.cp) * 0.003f;
                    double a = (s.cp + 1) * Math.PI / 4; // equal-power pan
                    float v = f[i] / 32768f * s.cg * 1.414f;
                    L[i] += v * (float) Math.cos(a);
                    R[i] += v * (float) Math.sin(a);
                }
            }
            float m = deaf ? 0 : vol;
            double sq = 0;
            for (int i = 0; i < FRAME; i++) {
                out[2 * i] = clip(L[i] * m);
                out[2 * i + 1] = clip(R[i] * m);
                float mono = (L[i] + R[i]) * 0.5f * m; sq += mono * mono;
            }
            float lvl = (float) Math.sqrt(sq / FRAME);
            if (lvl > 0.003f) {
                long nowMs = SystemClock.uptimeMillis();
                remoteLvl = nowMs < remoteUntil ? Math.max(remoteLvl * 0.9f, lvl) : lvl;
                remoteUntil = nowMs + 250;
            }
            AudioTrack t = track;
            if (t == null) break;
            t.write(out, 0, out.length); // blocking: คุมจังหวะเวลาจริง
        }
    }

    private static short clip(float v) {
        int x = (int) (v * 32767);
        return (short) (x > 32767 ? 32767 : (x < -32768 ? -32768 : x));
    }
}
