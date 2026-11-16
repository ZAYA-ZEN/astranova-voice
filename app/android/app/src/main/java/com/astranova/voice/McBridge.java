package com.astranova.voice;

import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * ตัวเชื่อมโลกธรรมดา: Minecraft ในเครื่องนี้พิมพ์ /wsserver localhost:19140
 * แล้วตัวนี้ส่งต่อข้อความไปที่ระบบเสียง (wss://…/mc) ทั้งไปและกลับ
 */
public class McBridge implements Runnable {
    private static final String TAG = "AstraBridge";
    private static McBridge inst;
    private static final OkHttpClient http = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build();

    private volatile String target;
    private final int port;

    private McBridge(String target, int port) { this.target = target; this.port = port; }

    public static synchronized void start(String target, int port) throws IOException {
        if (inst != null) { inst.target = target; return; }
        McBridge b = new McBridge(target, port);
        ServerSocket ss = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
        ss.setReuseAddress(true);
        b.server = ss;
        inst = b;
        new Thread(b, "astra-bridge").start();
    }

    private ServerSocket server;

    @Override
    public void run() {
        while (true) {
            try {
                Socket s = server.accept();
                new Thread(() -> handle(s), "astra-bridge-conn").start();
            } catch (IOException e) {
                Log.w(TAG, "accept: " + e);
                return;
            }
        }
    }

    private void handle(Socket sock) {
        WebSocket up = null;
        try {
            sock.setTcpNoDelay(true);
            InputStream in = sock.getInputStream();
            final OutputStream out = sock.getOutputStream();
            // --- HTTP upgrade ---
            String headers = readHeaders(in);
            String key = null;
            for (String line : headers.split("\r\n")) {
                int i = line.indexOf(':');
                if (i > 0 && line.substring(0, i).trim().equalsIgnoreCase("Sec-WebSocket-Key")) key = line.substring(i + 1).trim();
            }
            if (key == null) { sock.close(); return; }
            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            String accept = Base64.encodeToString(sha.digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();

            // --- ต่อขึ้นระบบเสียง ---
            final Object lock = new Object();
            up = http.newWebSocket(new Request.Builder().url(target).build(), new WebSocketListener() {
                @Override public void onMessage(WebSocket w, String text) {
                    try { synchronized (lock) { writeFrame(out, 1, text.getBytes(StandardCharsets.UTF_8)); } }
                    catch (IOException e) { w.cancel(); }
                }
                @Override public void onClosed(WebSocket w, int c, String r) { closeQuiet(sock); }
                @Override public void onFailure(WebSocket w, Throwable t, Response r) { Log.w(TAG, "upstream: " + t); closeQuiet(sock); }
            });

            // --- อ่านเฟรมจาก Minecraft ---
            DataInputStream din = new DataInputStream(in);
            ByteArrayOutputStream msg = new ByteArrayOutputStream();
            while (true) {
                int b0 = din.read();
                if (b0 < 0) break;
                int b1 = din.readUnsignedByte();
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) len = din.readUnsignedShort();
                else if (len == 127) len = din.readLong();
                if (len > 8 * 1024 * 1024) break;
                byte[] mask = new byte[4];
                if (masked) din.readFully(mask);
                byte[] data = new byte[(int) len];
                din.readFully(data);
                if (masked) for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
                if (op == 8) break;                                   // close
                if (op == 9) { synchronized (lock) { writeFrame(out, 10, data); } continue; } // ping → pong
                if (op == 10) continue;
                if (op == 1 || op == 2 || op == 0) {
                    msg.write(data);
                    if (fin) { up.send(new String(msg.toByteArray(), StandardCharsets.UTF_8)); msg.reset(); }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "conn: " + e);
        } finally {
            if (up != null) up.close(1000, null);
            closeQuiet(sock);
        }
    }

    private static String readHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, n = 0;
        while ((c = in.read()) >= 0) {
            b.write(c);
            n = (c == '\r' || c == '\n') ? n + 1 : 0;
            if (n == 4 || b.size() > 16384) break;
        }
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void writeFrame(OutputStream out, int op, byte[] data) throws IOException {
        out.write(0x80 | op);
        int len = data.length;
        if (len < 126) out.write(len);
        else if (len < 65536) { out.write(126); out.write(len >> 8); out.write(len & 255); }
        else { out.write(127); for (int i = 7; i >= 0; i--) out.write((int) (((long) len) >> (8 * i)) & 255); }
        out.write(data);
        out.flush();
    }

    private static void closeQuiet(Socket s) { try { s.close(); } catch (IOException ignored) {} }
}
