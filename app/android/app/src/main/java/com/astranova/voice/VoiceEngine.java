package com.astranova.voice;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
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
    static final int C_PCM = 0, C_ADPCM = 1, C_OPUS = 2;

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
    public volatile boolean active = false, muted = false, deaf = false, ptt = false, pttDown = false, echoGate = true;
    public volatile float threshold = 0.02f, boost = 1f, vol = 1f;
    public volatile int vfxId = 0; // ตัวเปลี่ยนเสียง (แอดมิน)
    private final VoiceFx vfx = new VoiceFx();
    public volatile String inputId = "", outputId = "";
    public final Map<Integer, Float> spkVol = new ConcurrentHashMap<>();

    // การบีบอัด
    private volatile boolean needOpus = false, needAdpcm = true;
    private final Adpcm adpcm = new Adpcm();
    private OpusCodec.Enc opusEnc;
    private volatile String codecName = "";

    // เสียง
    private AudioManager am;
    private AudioRecord rec;
    private AudioTrack track;
    private AcousticEchoCanceler aec;
    private NoiseSuppressor ns;
    private Thread capT, mixT;
    private volatile boolean running = false;
    private volatile float remoteLvl = 0;
    private volatile long remoteUntil = 0;
    private final ConcurrentHashMap<Integer, Spk> spk = new ConcurrentHashMap<>();

    /** ผู้พูดแต่ละคน: บัฟเฟอร์วน + ตัวกรองเสียงทึบ + ตัวถอด Opus */
    static class Spk {
        final short[] ring = new short[RATE * 2];
        int w = 0, r = 0, count = 0;
        volatile float gain = 0, pan = 0, cutoff = 0;
        float cg = -1, cp = 0, lp1 = 0, lp2 = 0, ca = 1;
        boolean primed = false;
        volatile long last = 0;
        OpusCodec.Dec dec;
        synchronized void push(short[] s, int n) {
            for (int i = 0; i < n; i++) {
                ring[w] = s[i]; w = (w + 1) % ring.length;
                if (count < ring.length) count++; else r = (r + 1) % ring.length;
            }
            if (count > RATE / 2) { int drop = count - RATE / 5; r = (r + drop) % ring.length; count -= drop; } // ดีเลย์สะสม → ตัดทิ้ง
        }
        synchronized int pop(short[] dst, int n) {
            int m = Math.min(n, count);
            for (int i = 0; i < m; i++) { dst[i] = ring[r]; r = (r + 1) % ring.length; }
            count -= m;
            return m;
        }
        synchronized int available() { return count; }
    }

    void emit(JSObject ev) { Listener l = listener; if (l != null) try { l.onEvent(ev); } catch (Exception ignored) {} }
    void emit(String type) { JSObject o = new JSObject(); o.put("type", type); emit(o); }
    public boolean isOpen() { return open; }

    // ---------------- WebSocket ----------------
    public synchronized void connect(String url, String hello) {
        this.url = url; want = true;
        try {
            JSONObject h = new JSONObject(hello);
            JSONArray enc = new JSONArray(), dec = new JSONArray();
            if (OpusCodec.canEncode()) enc.put("opus");
            if (OpusCodec.canDecode()) dec.put("opus");
            enc.put("adpcm"); dec.put("adpcm");
            h.put("codecs", new JSONObject().put("enc", enc).put("dec", dec));
            this.hello = h.toString();
        } catch (Exception e) { this.hello = hello; }
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
                if (text.startsWith("{\"t\":\"enc\"")) { onEnc(text); return; }
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

    private void onEnc(String text) {
        try {
            JSONArray a = new JSONObject(text).getJSONArray("codecs");
            boolean o = false, d = false;
            for (int i = 0; i < a.length(); i++) { String c = a.getString(i); if ("opus".equals(c)) o = true; if ("adpcm".equals(c)) d = true; }
            needOpus = o && OpusCodec.canEncode();
            needAdpcm = d || !needOpus;
            String name = needOpus ? "Opus" : "ADPCM";
            if (!name.equals(codecName)) { codecName = name; JSObject ev = new JSObject(); ev.put("type", "codec"); ev.put("name", name); emit(ev); }
        } catch (Exception ignored) {}
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

    // ---------------- อุปกรณ์เสียง ----------------
    private static String typeName(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "ไมค์ในเครื่อง";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "ลำโพงเครื่อง";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "ลำโพงสนทนา (หูฟังโทรศัพท์)";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "หูฟังมีสาย (มีไมค์)";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "หูฟังมีสาย";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "บลูทูธ";
            case AudioDeviceInfo.TYPE_USB_HEADSET: case AudioDeviceInfo.TYPE_USB_DEVICE: return "USB";
            default: return Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET ? "บลูทูธ LE" : "อุปกรณ์ " + t;
        }
    }

    public JSObject listDevices(Context ctx) {
        AudioManager a = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        JSArray ins = new JSArray(), outs = new JSArray();
        for (AudioDeviceInfo d : a.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_TELEPHONY || t == AudioDeviceInfo.TYPE_REMOTE_SUBMIX || t == AudioDeviceInfo.TYPE_FM_TUNER) continue;
            JSObject o = new JSObject(); o.put("id", String.valueOf(d.getId()));
            String pn = String.valueOf(d.getProductName());
            o.put("name", typeName(t) + (pn.isEmpty() || pn.equals(Build.MODEL) ? "" : " · " + pn) + (d.getAddress() != null && !d.getAddress().isEmpty() ? " (" + d.getAddress() + ")" : ""));
            ins.put(o);
        }
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : a.getAvailableCommunicationDevices()) {
                JSObject o = new JSObject(); o.put("id", String.valueOf(d.getId()));
                String pn = String.valueOf(d.getProductName());
                o.put("name", typeName(d.getType()) + (pn.isEmpty() || pn.equals(Build.MODEL) ? "" : " · " + pn));
                outs.put(o);
            }
        } else {
            JSObject s = new JSObject(); s.put("id", "speaker"); s.put("name", "ลำโพงเครื่อง"); outs.put(s);
            JSObject e = new JSObject(); e.put("id", "earpiece"); e.put("name", "ลำโพงสนทนา / หูฟัง"); outs.put(e);
        }
        JSObject r = new JSObject(); r.put("inputs", ins); r.put("outputs", outs);
        return r;
    }

    private AudioDeviceInfo findDevice(int flag, String id) {
        if (am == null || id == null || id.isEmpty()) return null;
        for (AudioDeviceInfo d : am.getDevices(flag)) if (String.valueOf(d.getId()).equals(id)) return d;
        return null;
    }

    public void applyDevices() {
        try {
            if (rec != null) rec.setPreferredDevice(findDevice(AudioManager.GET_DEVICES_INPUTS, inputId));
        } catch (Exception e) { Log.w(TAG, "input: " + e); }
        routeOutput();
    }

    /** ลำโพงที่เลือก หรืออัตโนมัติ: มีหูฟัง → หูฟัง, ไม่มี → ลำโพงใหญ่ */
    @SuppressWarnings("deprecation")
    private void routeOutput() {
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo pick = null, speaker = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (String.valueOf(d.getId()).equals(outputId)) { pick = d; break; }
                }
                if (pick == null) for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) speaker = d;
                    else if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                            || t == AudioDeviceInfo.TYPE_BLE_HEADSET) { if (pick == null) pick = d; }
                }
                if (pick == null) pick = speaker;
                if (pick != null) am.setCommunicationDevice(pick);
            } else {
                if ("speaker".equals(outputId)) am.setSpeakerphoneOn(true);
                else if ("earpiece".equals(outputId)) am.setSpeakerphoneOn(false);
                else am.setSpeakerphoneOn(!(am.isWiredHeadsetOn() || am.isBluetoothScoOn() || am.isBluetoothA2dpOn()));
            }
        } catch (Exception e) { Log.w(TAG, "route: " + e); }
    }

    // ---------------- Audio ----------------
    public synchronized void startAudio(Context ctx) {
        if (running) return;
        am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        try { am.setMode(AudioManager.MODE_IN_COMMUNICATION); } catch (Exception ignored) {}
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 2 * 4));
            if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(rec.getAudioSessionId()); if (aec != null) aec.setEnabled(true); }
            if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(rec.getAudioSessionId()); if (ns != null) ns.setEnabled(true); }
            applyDevices();
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
        if (opusEnc != null) { opusEnc.release(); opusEnc = null; }
        rec = null; track = null; aec = null; ns = null;
        for (Spk s : spk.values()) if (s.dec != null) s.dec.release();
        spk.clear();
        try {
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice(); else am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {}
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
            if (vfxId > 0) vfx.process(buf, FRAME, vfxId);
            // Opus: ป้อนทุกเฟรมต่อเนื่อง ส่งเฉพาะตอนพูด
            if (needOpus) {
                try {
                    if (opusEnc == null) opusEnc = new OpusCodec.Enc();
                    List<byte[]> pk = opusEnc.encode(buf, FRAME);
                    if (t && !pk.isEmpty()) sendPacked(pk);
                } catch (Exception e) { Log.w(TAG, "opus enc: " + e); needOpus = false; needAdpcm = true; }
            }
            if (needAdpcm && t) {
                if (!tx && prev != null && !ptt) sendAdpcm(prev);
                sendAdpcm(buf);
            }
            tx = t;
            prev = buf.clone();
            if (now - lastLevel > 100) {
                lastLevel = now;
                JSObject o = new JSObject(); o.put("type", "level"); o.put("rms", rms); o.put("tx", t); emit(o);
            }
        }
    }

    private void sendAdpcm(short[] s) {
        WebSocket w = ws;
        if (w == null) return;
        byte[] a = adpcm.encode(s, s.length);
        byte[] out = new byte[a.length + 1];
        out[0] = C_ADPCM; System.arraycopy(a, 0, out, 1, a.length);
        w.send(ByteString.of(out));
    }

    private void sendPacked(List<byte[]> pk) {
        WebSocket w = ws;
        if (w == null) return;
        int len = 2;
        for (byte[] p : pk) len += 2 + p.length;
        byte[] out = new byte[len];
        out[0] = C_OPUS; out[1] = (byte) pk.size();
        int o = 2;
        for (byte[] p : pk) { out[o] = (byte) p.length; out[o + 1] = (byte) (p.length >> 8); System.arraycopy(p, 0, out, o + 2, p.length); o += 2 + p.length; }
        w.send(ByteString.of(out));
    }

    // เสียงจากคนอื่น: [slot u16][gain u8][pan i8][lowpass/50 u8][codec u8][ข้อมูล]
    private void onAudio(byte[] d) {
        if (deaf || d.length < 7) return;
        int slot = (d[0] & 255) | ((d[1] & 255) << 8);
        float gain = (d[2] & 255) / 255f, pan = d[3] / 127f;
        int lp = (d[4] & 255) * 50, codec = d[5] & 255;
        Spk sp = spk.get(slot);
        if (sp == null) { sp = new Spk(); spk.put(slot, sp); }
        Float m = spkVol.get(slot);
        sp.gain = gain * (m != null ? m : 1f); sp.pan = pan; sp.cutoff = lp; sp.last = SystemClock.uptimeMillis();
        try {
            if (codec == C_ADPCM) {
                short[] s = Adpcm.decode(d, 6, d.length - 6, FRAME);
                sp.push(s, s.length);
            } else if (codec == C_OPUS) {
                if (sp.dec == null) sp.dec = new OpusCodec.Dec();
                int n = d[6] & 255, o = 7;
                for (int i = 0; i < n && o + 2 <= d.length; i++) {
                    int l = (d[o] & 255) | ((d[o + 1] & 255) << 8); o += 2;
                    if (o + l > d.length) break;
                    short[] s = sp.dec.decode(d, o, l);
                    if (s.length > 0) sp.push(s, s.length);
                    o += l;
                }
            } else {
                int n = (d.length - 6) / 2;
                short[] s = new short[n];
                for (int i = 0; i < n; i++) s[i] = (short) ((d[6 + 2 * i] & 255) | (d[7 + 2 * i] << 8));
                sp.push(s, n);
            }
        } catch (Exception e) { Log.w(TAG, "decode: " + e); }
    }

    private void mixLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        float[] L = new float[FRAME], R = new float[FRAME];
        short[] tmp = new short[FRAME];
        short[] out = new short[FRAME * 2];
        while (running) {
            java.util.Arrays.fill(L, 0); java.util.Arrays.fill(R, 0);
            long now = SystemClock.uptimeMillis();
            for (Map.Entry<Integer, Spk> e : spk.entrySet()) {
                Spk s = e.getValue();
                if (now - s.last > 10000) { if (s.dec != null) s.dec.release(); spk.remove(e.getKey()); continue; }
                if (!s.primed) { if (s.available() >= FRAME * 2) s.primed = true; else continue; }
                int n = s.pop(tmp, FRAME);
                if (n < FRAME) s.primed = false;
                if (n == 0) continue;
                if (s.cg < 0) { s.cg = s.gain; s.cp = s.pan; }
                // ตัวกรองเสียงทึบ (ผนัง/ใต้น้ำ): low-pass 2 ชั้น
                float targetA = s.cutoff > 0 ? (float) (1 - Math.exp(-2 * Math.PI * s.cutoff / RATE)) : 1f;
                for (int i = 0; i < n; i++) {
                    s.cg += (s.gain - s.cg) * 0.003f;
                    s.cp += (s.pan - s.cp) * 0.003f;
                    s.ca += (targetA - s.ca) * 0.002f;
                    float x = tmp[i] / 32768f;
                    s.lp1 += s.ca * (x - s.lp1);
                    s.lp2 += s.ca * (s.lp1 - s.lp2);
                    double a = (s.cp + 1) * Math.PI / 4; // equal-power pan
                    float v = s.lp2 * s.cg * 1.414f;
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
