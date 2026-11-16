package com.astranova.voice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.getcapacitor.JSObject;

/** Foreground service: ทำให้ไมค์/ลำโพงทำงานต่อเมื่อพับแอปไปเล่นเกม (เหมือน Discord) */
public class VoiceService extends Service {
    static final String CH = "astra_voice";
    static final int ID = 7101;
    static final String ACT_MUTE = "com.astranova.voice.MUTE";
    static final String ACT_STOP = "com.astranova.voice.STOP";
    static final String ACT_UPDATE = "com.astranova.voice.UPDATE";

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        VoiceEngine e = VoiceEngine.get();
        String act = intent != null ? intent.getAction() : null;
        if (ACT_STOP.equals(act)) {
            e.emit("stopReq");
            e.close();
            e.stopAudio();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACT_MUTE.equals(act)) {
            e.muted = !e.muted;
            JSObject o = new JSObject(); o.put("type", "mute"); o.put("muted", e.muted); e.emit(o);
        }
        int type = 0;
        if (Build.VERSION.SDK_INT >= 30) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        else if (Build.VERSION.SDK_INT >= 29) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        ServiceCompat.startForeground(this, ID, build(e.muted), type);
        if (!ACT_UPDATE.equals(act) && !ACT_MUTE.equals(act)) {
            acquireLocks();
            e.startAudio(this);
        }
        return START_NOT_STICKY;
    }

    private Notification build(boolean muted) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel c = new NotificationChannel(CH, "ไมค์ตามระยะ", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, open, fl);
        PendingIntent pMute = PendingIntent.getService(this, 1, new Intent(this, VoiceService.class).setAction(ACT_MUTE), fl);
        PendingIntent pStop = PendingIntent.getService(this, 2, new Intent(this, VoiceService.class).setAction(ACT_STOP), fl);
        return new NotificationCompat.Builder(this, CH)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Astra Nova Voice")
                .setContentText(muted ? "ไมค์ปิดอยู่ • ยังได้ยินคนรอบตัว" : "กำลังใช้ไมค์ตามระยะ")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pOpen)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .addAction(0, muted ? "เปิดไมค์" : "ปิดไมค์", pMute)
                .addAction(0, "ตัดการเชื่อมต่อ", pStop)
                .build();
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "astra:voice");
            wake.acquire();
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "astra:voice");
                wifi.acquire();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null; wifi = null;
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // ปัดแอปทิ้งจากหน้าแอปล่าสุด = เลิกใช้งาน
        VoiceEngine e = VoiceEngine.get();
        e.close(); e.stopAudio();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }
}
