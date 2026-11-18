package com.astranova.voice;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "VoiceEngine", permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone")
})
public class VoiceEnginePlugin extends Plugin {

    @Override
    public void load() {
        VoiceEngine.get().listener = ev -> notifyListeners("event", ev);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        VoiceEngine.get().connect(call.getString("url"), call.getString("hello"));
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        VoiceEngine.get().send(call.getString("text", ""));
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        VoiceEngine.get().close();
        call.resolve();
    }

    @PluginMethod
    public void startAudio(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void micPermCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) doStart(call);
        else call.reject("ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน");
    }

    private void doStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null &&
                ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7102);
        }
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), VoiceService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("เริ่มบริการเสียงไม่ได้: " + e.getMessage());
        }
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        call.resolve(VoiceEngine.get().listDevices(getContext()));
    }

    @PluginMethod
    public void startBridge(PluginCall call) {
        try {
            McBridge.start(call.getString("url"), call.getInt("port", 19140));
            call.resolve();
        } catch (Exception e) {
            call.reject("เปิดตัวเชื่อมไม่ได้: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopAudio(PluginCall call) {
        VoiceEngine.get().stopAudio();
        getContext().stopService(new Intent(getContext(), VoiceService.class));
        call.resolve();
    }

    @PluginMethod
    public void setOpts(PluginCall call) {
        VoiceEngine e = VoiceEngine.get();
        boolean wasMuted = e.muted;
        if (call.hasOption("active")) e.active = call.getBoolean("active", false);
        if (call.hasOption("muted")) e.muted = call.getBoolean("muted", false);
        if (call.hasOption("deaf")) e.deaf = call.getBoolean("deaf", false);
        if (call.hasOption("ptt")) e.ptt = call.getBoolean("ptt", false);
        if (call.hasOption("pttDown")) e.pttDown = call.getBoolean("pttDown", false);
        if (call.hasOption("threshold")) e.threshold = call.getFloat("threshold", 0.02f);
        if (call.hasOption("boost")) e.boost = call.getFloat("boost", 1f);
        if (call.hasOption("fx")) {
            float[] fx = null;
            try {
                com.getcapacitor.JSArray arr = call.getArray("fx");
                if (arr != null && arr.length() >= 23) {
                    fx = new float[arr.length()];
                    for (int i = 0; i < fx.length; i++) fx[i] = (float) arr.getDouble(i);
                }
            } catch (Exception ignored) { fx = null; }
            e.fxParams = fx;
        }
        if (call.hasOption("ns")) e.nsLevel = call.getInt("ns", 1);
        if (call.hasOption("vol")) e.vol = call.getFloat("vol", 1f);
        if (call.hasOption("echoGate")) e.echoGate = call.getBoolean("echoGate", true);
        boolean devChanged = false;
        if (call.hasOption("inputId")) { String v = call.getString("inputId", ""); if (!v.equals(e.inputId)) { e.inputId = v; devChanged = true; } }
        if (call.hasOption("outputId")) { String v = call.getString("outputId", ""); if (!v.equals(e.outputId)) { e.outputId = v; devChanged = true; } }
        if (devChanged && e.isRunning()) e.applyDevices();
        if (call.hasOption("spkVol")) {
            JSObject m = call.getObject("spkVol", new JSObject());
            e.spkVol.clear();
            java.util.Iterator<String> it = m.keys();
            while (it.hasNext()) {
                String k = it.next();
                try { e.spkVol.put(Integer.parseInt(k), (float) m.getDouble(k)); } catch (Exception ignored) {}
            }
        }
        if (wasMuted != e.muted && e.isRunning()) {
            try { getContext().startService(new Intent(getContext(), VoiceService.class).setAction(VoiceService.ACT_UPDATE)); } catch (Exception ignored) {}
        }
        call.resolve();
    }
}
