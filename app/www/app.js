// Astra Nova Voice app — UI ชุดเดียวใช้ทุกเครื่อง
// มือถือ (Android/iOS): เสียง+การเชื่อมต่อทำงานในโค้ด native → ใช้งานเบื้องหลังได้แบบ Discord
// Windows/เว็บ: ใช้ Web Audio ในหน้าเว็บ
"use strict";
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("mcv:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mcv:" + k, JSON.stringify(v)); } catch {} },
};
const RATE = 16000, FRAME = 640; // 40ms
const CFG = window.ASTRA_CONFIG || {};
const CAP = window.Capacitor;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform() && CAP.registerPlugin);
const VE = NATIVE ? CAP.registerPlugin("VoiceEngine") : null;

// ---------- state ----------
let wantConnected = false, linked = false;
// เปิดเป็นเว็บจากลิงก์ Render → ใช้เซิร์ฟเวอร์เดียวกับหน้าเว็บเลย
const isLocal = (u) => /^(\w+:\/\/)?(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(String(u || ""));
const SELF = !NATIVE && !window.mcvoiceNative && /^https?:$/.test(location.protocol) && !isLocal(location.host) ? location.origin : "";
if (isLocal(store.get("server", ""))) store.set("server", ""); // ค่าเสียจากเวอร์ชันก่อน
let server = SELF || store.get("server", "") || CFG.serverUrl || "", name = store.get("name", "");
let echoGate = store.get("echoGate", true);
const IS_SAFARI = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) || /iP(hone|ad|od)/.test(navigator.userAgent);
let muted = store.get("muted", false), deaf = false;
let mode = store.get("mode", "vad"), pttDown = false;
let sens = store.get("sens", 60), boost = store.get("boost", 100), vol = store.get("vol", 100);
let status = null;

// ---------- helpers ----------
function show(scr) {
  for (const s of ["scrConnect", "scrLink", "scrWait", "scrMain"]) $(s).classList.toggle("hidden", s !== scr);
  $("topbar").classList.toggle("hidden", scr !== "scrMain");
}
function toast(html, ms = 6000) { const t = $("toast"); t.innerHTML = html; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), ms); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tokenKey = () => "tok2:" + server.toLowerCase();
let myRange = store.get("myRange", null), maxRange = 100, pendingCode = "";
const threshold = () => 0.002 + Math.pow((100 - sens) / 100, 2) * 0.08;

function wsUrl(s) {
  s = s.trim();
  if (/^wss?:\/\//i.test(s)) return s.replace(/\/+$/, "").replace(/(\/voice)?$/, "/voice");
  if (/^https:\/\//i.test(s)) return "wss://" + s.slice(8).replace(/\/+$/, "") + "/voice";
  if (/^http:\/\//i.test(s)) return "ws://" + s.slice(7).replace(/\/+$/, "") + "/voice";
  if (/onrender\.com|\.[a-z]{2,}$/i.test(s) && !/:\d+/.test(s)) return "wss://" + s.replace(/\/+$/, "") + "/voice"; // โดเมน → wss
  if (!/:\d+/.test(s)) s += ":8080";
  return "ws://" + s.replace(/\/+$/, "") + "/voice";
}

// =====================================================================
// ชั้นการเชื่อมต่อ + เสียง: Native (มือถือ) หรือ Web (Windows/เว็บ)
// =====================================================================
const engine = NATIVE ? nativeEngine() : webEngine();

let nativeCodec = "";
function nativeEngine() {
  VE.addListener("event", (ev) => {
    switch (ev.type) {
      case "open": onOpen(); break;
      case "close": onClose(); break;
      case "msg": try { onMsg(JSON.parse(ev.data)); } catch {} break;
      case "level": onLevel(ev.rms, ev.tx); break;
      case "codec": nativeCodec = ev.name; break;
      case "mute": muted = !!ev.muted; store.set("muted", muted); sendState(); renderMic(); break; // กดจากแจ้งเตือน
      case "stopReq": wantConnected = false; renderAcct(); break;
      case "error": toast("<b>เสียงมีปัญหา</b><br>" + esc(ev.message), 8000); break;
    }
  });
  let isOpen = false;
  function onOpen() { isOpen = true; }
  function onClose() { isOpen = false; handleClose(); }
  return {
    connect(url, hello) { return VE.connect({ url, hello: JSON.stringify(hello) }); },
    send(o) { VE.send({ text: JSON.stringify(o) }); },
    close() { VE.close(); },
    isOpen: () => isOpen,
    startAudio() { return VE.startAudio().catch((e) => toast("<b>ใช้ไมค์ไม่ได้</b><br>" + esc(e.message || e) + "<br>อนุญาตไมโครโฟนในตั้งค่าเครื่อง", 12000)); },
    stopAudio() { VE.stopAudio(); },
    setOpts(o) { VE.setOpts(o); },
    async listDevices() { try { return await VE.listDevices(); } catch { return { inputs: [], outputs: [] }; } },
    codecInfo: () => nativeCodec,
  };
}

function webEngine() {
  const C = window.AstraCodec;
  let ws = null, url = null, hello = null, reconnectTimer = null;
  let ctx = null, micStream = null, micSrc = null, capNode = null, boostNode = null, master = null, audioBusy = null, outEl = null;
  const speakers = new Map();
  let opts = {}, hangUntil = 0, preroll = null, transmitting = false;
  let remoteLvl = 0, remoteUntil = 0, wakeLock = null, aecRouted = false;
  let encCodecs = ["adpcm"];               // เซิร์ฟเวอร์บอกว่าต้องส่งแบบไหน
  const adpcmEnc = C ? new C.Encoder() : null;
  let opusEnc = null, opusTs = 0, opusOk = false;
  const txByTs = new Map();

  // ---------- Opus (WebCodecs) ----------
  const OPUS_CFG = { codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: 40000, application: "voip", complexity: 5 } };
  const DEC_CFG = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
  async function opusSupport() {
    try {
      if (!window.AudioEncoder || !window.AudioDecoder || !window.AudioData) return { enc: false, dec: false };
      const e = await AudioEncoder.isConfigSupported(OPUS_CFG);
      const d = await AudioDecoder.isConfigSupported(DEC_CFG);
      return { enc: !!e.supported, dec: !!d.supported };
    } catch { return { enc: false, dec: false }; }
  }
  const caps = opusSupport();
  function makeOpusEncoder() {
    try {
      const e = new AudioEncoder({
        output: (chunk) => {
          const tx = txByTs.get(chunk.timestamp); txByTs.delete(chunk.timestamp);
          if (!tx || !ws || ws.readyState !== 1) return;
          const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
          const p = C.packOpus([b]); const out = new Uint8Array(1 + p.length); out[0] = C.OPUS; out.set(p, 1);
          ws.send(out);
        },
        error: (err) => { console.warn("opus enc", err); opusEnc = null; },
      });
      e.configure(OPUS_CFG);
      return e;
    } catch (err) { console.warn("opus enc init", err); return null; }
  }

  function open() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = async () => {
      const c = await caps;
      opusOk = c.enc;
      ws.send(JSON.stringify({ ...hello, codecs: { enc: c.enc ? ["opus", "adpcm"] : ["adpcm"], dec: c.dec ? ["opus", "adpcm"] : ["adpcm"] } }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return play(ev.data);
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "enc") { encCodecs = m.codecs || ["adpcm"]; return; }
      onMsg(m);
    };
    ws.onclose = () => { handleClose(); if (wantConnected && ws) reconnectTimer = setTimeout(open, 2000); };
  }

  const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.ratio = sampleRate / ${RATE}; this.pos = 0; this.acc = 0; this.n = 0; this.buf = new Int16Array(${FRAME}); this.i = 0; this.sq = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.n; this.acc = 0; this.n = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.buf[this.i++] = v * 32767; this.sq += v * v;
        if (this.i === ${FRAME}) {
          this.port.postMessage({ pcm: this.buf.buffer, rms: Math.sqrt(this.sq / ${FRAME}) }, [this.buf.buffer]);
          this.buf = new Int16Array(${FRAME}); this.i = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mcv-cap", Cap);`;

  // ส่งเสียงที่เล่นออกลำโพงผ่าน WebRTC loopback → ตัวตัดเสียงสะท้อนของ Chrome/Windows รู้ว่าเราเล่นอะไร
  async function loopbackOut(stream) {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const got = new Promise((res) => { b.ontrack = (e) => res(e.streams[0] || new MediaStream([e.track])); });
    stream.getTracks().forEach((t) => a.addTrack(t, stream));
    const stereo = (sdp) => sdp.replace(/useinbandfec=1/g, "useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000");
    const offer = await a.createOffer(); offer.sdp = stereo(offer.sdp);
    await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
    const ans = await b.createAnswer(); ans.sdp = stereo(ans.sdp);
    await b.setLocalDescription(ans); await a.setRemoteDescription(ans);
    const remote = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    const el = new Audio(); el.srcObject = remote; el.autoplay = true;
    await el.play();
    return el;
  }

  async function startMic() {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (micSrc) { try { micSrc.disconnect(); } catch {} micSrc = null; }
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (opts.inputId) audio.deviceId = { exact: opts.inputId };
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) { if (opts.inputId) { delete audio.deviceId; micStream = await navigator.mediaDevices.getUserMedia({ audio }); } else throw e; }
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(boostNode);
  }

  async function start() {
    try {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        master = ctx.createGain(); master.gain.value = opts.deaf ? 0 : (opts.vol ?? 1);
        if (!IS_SAFARI && window.RTCPeerConnection && ctx.createMediaStreamDestination) {
          try { const dest = ctx.createMediaStreamDestination(); master.connect(dest); outEl = await loopbackOut(dest.stream); aecRouted = true; }
          catch (e) { console.warn("AEC loopback ไม่ได้", e); }
        }
        if (!aecRouted) master.connect(ctx.destination);
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
        boostNode = ctx.createGain(); boostNode.gain.value = opts.boost ?? 1;
        capNode = new AudioWorkletNode(ctx, "mcv-cap");
        const sink = ctx.createGain(); sink.gain.value = 0;
        boostNode.connect(capNode).connect(sink).connect(ctx.destination);
        capNode.port.onmessage = (e) => capture(e.data);
        applyOutput();
      }
      if (ctx.state !== "running") ctx.resume().catch(() => {});
      if (!micStream) await startMic();
      try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
      setTimeout(() => { if (ctx && ctx.state !== "running") toast("แตะปุ่มไมค์หนึ่งครั้งเพื่อเริ่มเสียง", 5000); }, 800);
    } catch (e) {
      toast("<b>ใช้ไมค์ไม่ได้</b><br>" + esc(e.message || e) + "<br>กรุณาอนุญาตการใช้ไมโครโฟน", 12000);
    }
  }

  function applyOutput() {
    const id = opts.outputId || "";
    try {
      if (outEl && outEl.setSinkId) outEl.setSinkId(id).catch(() => {});
      else if (ctx && ctx.setSinkId) ctx.setSinkId(id).catch(() => {});
    } catch {}
  }

  function sendAudio(pcm, tx) {
    // Opus: ป้อนทุกเฟรมให้ตัวบีบอัดต่อเนื่อง ส่งเฉพาะเฟรมที่พูด
    if (encCodecs.includes("opus") && opusOk) {
      if (!opusEnc || opusEnc.state === "closed") opusEnc = makeOpusEncoder();
      if (opusEnc) {
        const f32 = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
        const ts = (opusTs += 40000);
        if (tx) txByTs.set(ts, true);
        if (txByTs.size > 50) txByTs.clear();
        try {
          const ad = new AudioData({ format: "f32-planar", sampleRate: RATE, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: ts, data: f32 });
          opusEnc.encode(ad); ad.close();
        } catch (e) { console.warn(e); }
      }
    }
    if (!tx || !ws || ws.readyState !== 1) return;
    if (encCodecs.includes("adpcm") || !opusOk) {
      const a = adpcmEnc.encode(pcm); const out = new Uint8Array(1 + a.length); out[0] = C.ADPCM; out.set(a, 1);
      ws.send(out);
    }
  }

  function capture({ pcm, rms }) {
    const s16 = new Int16Array(pcm);
    let tx = false;
    if (opts.active && !opts.muted && ws && ws.readyState === 1) {
      if (opts.ptt) tx = !!opts.pttDown;
      else {
        const now = performance.now();
        let th = opts.threshold ?? 0.02;
        if (opts.echoGate && now < remoteUntil) th = Math.max(th * 3, remoteLvl * 0.6);
        if (rms > th) hangUntil = now + 450;
        tx = now < hangUntil;
      }
    }
    // ส่งช่วงต้นคำที่ตกไป (เฉพาะ ADPCM — Opus ต้องป้อนต่อเนื่อง)
    if (tx && !transmitting && preroll && !opts.ptt && (encCodecs.includes("adpcm") || !opusOk) && ws) {
      const a = adpcmEnc.encode(preroll); const out = new Uint8Array(1 + a.length); out[0] = C.ADPCM; out.set(a, 1); ws.send(out);
    }
    sendAudio(s16, tx);
    preroll = s16; transmitting = tx;
    onLevel(rms, tx);
  }

  function speaker(slot) {
    let sp = speakers.get(slot);
    if (sp) return sp;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 20000; lp.Q.value = 0.7;
    gain.connect(lp);
    let out = lp, panner = null;
    if (ctx.createStereoPanner) { panner = ctx.createStereoPanner(); lp.connect(panner); out = panner; }
    out.connect(master);
    sp = { gain, lp, panner, next: 0, dec: null, g: 0 };
    speakers.set(slot, sp);
    return sp;
  }

  function schedule(sp, f32, rate) {
    const t = ctx.currentTime;
    let sq = 0; for (let i = 0; i < f32.length; i++) sq += f32[i] * f32[i];
    const lvl = Math.sqrt(sq / f32.length) * sp.g * (opts.vol ?? 1);
    const nowMs = performance.now();
    remoteLvl = nowMs < remoteUntil ? Math.max(remoteLvl * 0.9, lvl) : lvl;
    remoteUntil = nowMs + 250;
    const ab = ctx.createBuffer(1, f32.length, rate);
    ab.copyToChannel ? ab.copyToChannel(f32, 0) : ab.getChannelData(0).set(f32);
    const src = ctx.createBufferSource(); src.buffer = ab; src.connect(sp.gain);
    if (sp.next < t + 0.015 || sp.next > t + 0.45) sp.next = t + 0.09; // jitter buffer ~90ms
    src.start(sp.next); sp.next += ab.duration;
  }

  function play(buf) {
    if (!ctx || opts.deaf || buf.byteLength < 7) return;
    const dv = new DataView(buf);
    const slot = dv.getUint16(0, true), g = dv.getUint8(2) / 255, pan = dv.getInt8(3) / 127, lpHz = dv.getUint8(4) * 50, codec = dv.getUint8(5);
    const body = new Uint8Array(buf, 6);
    const sp = speaker(slot);
    const t = ctx.currentTime;
    const mult = (opts.spkVol && opts.spkVol[slot] != null) ? opts.spkVol[slot] : 1;
    sp.g = g * mult;
    sp.gain.gain.setTargetAtTime(sp.g, t, 0.06);
    sp.lp.frequency.setTargetAtTime(lpHz > 0 ? lpHz : 20000, t, 0.1);
    if (sp.panner) sp.panner.pan.setTargetAtTime(pan, t, 0.08);
    if (codec === C.ADPCM) {
      const s = C.adpcmDecode(body, FRAME); const f = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
      schedule(sp, f, RATE);
    } else if (codec === C.OPUS) {
      if (!sp.dec || sp.dec.state === "closed") {
        try {
          sp.dec = new AudioDecoder({
            output: (ad) => {
              const f = new Float32Array(ad.numberOfFrames);
              ad.copyTo(f, { planeIndex: 0, format: "f32-planar" });
              schedule(sp, f, ad.sampleRate); ad.close();
            },
            error: (e) => { console.warn("opus dec", e); sp.dec = null; },
          });
          sp.dec.configure(DEC_CFG);
        } catch (e) { console.warn(e); sp.dec = null; return; }
      }
      for (const pkt of C.unpackOpus(body)) {
        try { sp.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: (sp.ts = (sp.ts || 0) + 40000), data: pkt })); } catch (e) { console.warn(e); }
      }
    } else {
      const s = new Int16Array(buf.slice(6)); const f = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
      schedule(sp, f, RATE);
    }
  }

  setInterval(() => { if (ctx && ctx.state === "suspended" && linked) ctx.resume().catch(() => {}); }, 3000);
  document.addEventListener("visibilitychange", () => { if (ctx && ctx.state !== "running") ctx.resume().catch(() => {}); });

  return {
    async connect(u, h) { url = u; hello = h; new URL(u); open(); },
    send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); },
    close() { clearTimeout(reconnectTimer); if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; } },
    isOpen: () => !!ws && ws.readyState === 1,
    startAudio() { return (audioBusy ||= start().finally(() => { audioBusy = null; })); },
    stopAudio() {
      if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
      if (micSrc) { try { micSrc.disconnect(); } catch {} micSrc = null; }
    },
    setOpts(o) {
      const inChanged = "inputId" in o && o.inputId !== opts.inputId;
      const outChanged = "outputId" in o && o.outputId !== opts.outputId;
      Object.assign(opts, o);
      if (master) master.gain.value = opts.deaf ? 0 : (opts.vol ?? 1);
      if (boostNode) boostNode.gain.value = opts.boost ?? 1;
      if (inChanged && ctx && micStream) startMic().catch((e) => toast("เปลี่ยนไมค์ไม่ได้: " + esc(e.message || e)));
      if (outChanged) applyOutput();
    },
    async listDevices() {
      try {
        const d = await navigator.mediaDevices.enumerateDevices();
        const map = (k) => d.filter((x) => x.kind === k && x.deviceId !== "default" && x.deviceId !== "communications").map((x, i) => ({ id: x.deviceId, name: x.label || (k === "audioinput" ? "ไมค์ " : "ลำโพง ") + (i + 1) }));
        const canOut = !!((outEl && outEl.setSinkId) || (window.AudioContext && AudioContext.prototype.setSinkId));
        return { inputs: map("audioinput"), outputs: canOut ? map("audiooutput") : [] };
      } catch { return { inputs: [], outputs: [] }; }
    },
    codecInfo: () => (encCodecs.includes("opus") && opusOk ? "Opus" : "ADPCM"),
    debug: () => ({ speakers: speakers.size, aecRouted, enc: encCodecs, opusOk }),
    beep() {
      if (!ctx || opts.deaf) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.connect(g).connect(master); o.start(); o.stop(ctx.currentTime + 0.3);
    },
  };
}

// ส่งค่าปัจจุบันไปให้ engine
function pushOpts() {
  engine.setOpts({
    active: linked && (status ? status.canSpeak : true),
    muted, deaf, ptt: mode === "ptt", pttDown,
    threshold: threshold(), boost: boost / 100, vol: vol / 100, echoGate,
    inputId: store.get("inputId", ""), outputId: store.get("outputId", ""), spkVol: slotVolumes(),
  });
}

// =====================================================================
// โปรโตคอลกับเซิร์ฟเวอร์เสียง
// =====================================================================
function helloMsg() {
  const tok = store.get(tokenKey(), null);
  const h = { t: "hello", range: myRange ?? undefined };
  if (tok) h.token = tok; else if (name) h.name = name;
  return h;
}
function renderAcct() {
  const known = linked || !!name;
  $("acctOut").classList.toggle("hidden", known);
  $("acctIn").classList.toggle("hidden", !known);
  $("meName").textContent = name ? "👤 " + name : "";
  $("acctState").textContent = linked
    ? (status && status.inGame ? "✅ อยู่ในเกมแล้ว คุยได้เลย" : "✅ เชื่อมแล้ว — เข้าเกมเมื่อไหร่ก็พูดได้ทันที")
    : name ? "⏳ รอ " + name + " เข้าเกม… เข้าเกมแล้วพูดได้เลย ไม่ต้องทำอะไรเพิ่ม" : "";
  $("connTxt").textContent = wantConnected && !engine.isOpen() ? "กำลังเชื่อมต่อเซิร์ฟเวอร์เสียง…" : "";
}
function connect() {
  let url;
  try { url = wsUrl(server); new URL(url); } catch { $("errConnect").textContent = "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง"; return; }
  renderAcct();
  Promise.resolve(engine.connect(url, helloMsg()))
    .catch((e) => { $("errConnect").textContent = "เชื่อมต่อไม่ได้: " + (e.message || e); });
}

function wakeServer() {
  // ปลุกเซิร์ฟเวอร์ฟรีที่หลับอยู่ (Render) — ใช้เวลาได้ถึง ~1 นาที
  try { const u = new URL(wsUrl(server)); fetch((u.protocol === "wss:" ? "https://" : "http://") + u.host + "/healthz", { mode: "no-cors", cache: "no-store" }).catch(() => {}); } catch {}
}
function handleClose() {
  // ไม่โชว์ error — ต่อใหม่เองเงียบๆ (แอปมือถือต่อเองอยู่แล้ว, เว็บต่อใหม่ทุก 2 วินาที)
  $("dot").classList.remove("on");
  if (wantConnected) wakeServer();
  renderAcct(); renderBadges();
}

function onMsg(m) {
  $("connTxt").textContent = "";
  switch (m.t) {
    case "waiting": renderAcct(); break;
    case "link_code":
      pendingCode = m.code;
      if (store.get(tokenKey(), null)) { engine.send({ t: "resume", token: store.get(tokenKey(), null) }); break; }
      if (name) { connect(); break; } // ใส่ชื่อไว้แล้ว → เชื่อมด้วยชื่อ
      if (!$("scrLink").classList.contains("hidden")) showCode();
      break;
    case "resume_fail": store.set(tokenKey(), null); if (name) { connect(); } else renderAcct(); break;
    case "linked":
      linked = true;
      if (m.token) store.set(tokenKey(), m.token);
      store.set("auto", true);
      $("dot").classList.add("on");
      name = m.name; store.set("name", name);
      $("meName").textContent = m.name;
      if (m.maxRange != null) maxRange = m.maxRange;
      renderMyRange();
      if (myRange != null) engine.send({ t: "range", v: myRange });
      show("scrMain"); renderAcct();
      Promise.resolve(engine.startAudio()).then(() => { pushOpts(); sendState(); loadDevices(); });
      break;
    case "status": status = m; $("dot").classList.add("on"); renderStatus(); renderAcct(); pushOpts(); break;
    case "announce":
      toast("<b>📢 ประกาศ</b>" + (m.by ? " <span style='opacity:.7'>(" + esc(m.by) + ")</span>" : "") + "<br>" + esc(m.text), 10000);
      engine.beep && engine.beep();
      break;
    case "kicked": wantConnected = false; linked = false; toast(esc(m.reason)); engine.close(); renderAcct(); break;
    case "error": toast(esc(m.msg)); name = ""; store.set("name", ""); linked = false; connect(); break;
  }
}
const sendState = () => engine.send({ t: "state", mute: muted, deaf });

let lastLvl = 0;
function onLevel(rms, tx) {
  const now = performance.now();
  if (now - lastLvl < 60) return; lastLvl = now;
  $("lvl").style.width = Math.min(100, Math.sqrt(rms) * 220) + "%";
  $("btnMic").classList.toggle("tx", !!tx);
}

// =====================================================================
// แสดงผล
// =====================================================================
function renderMic() {
  const b = $("btnMic");
  const blocked = status && !status.canSpeak && !muted;
  b.classList.toggle("off", muted || !!blocked);
  b.textContent = muted ? "🔇" : "🎤";
  $("micHint").textContent = mode === "ptt" ? (muted ? "ไมค์ปิดอยู่ (แตะสองครั้งเพื่อเปิด)" : "กดค้างเพื่อพูด") : muted ? "ไมค์ปิดอยู่ — แตะเพื่อเปิด" : "ไมค์เปิดอยู่ — แตะเพื่อปิด";
  $("btnDeaf").classList.toggle("on", deaf);
  $("btnDeaf").textContent = deaf ? "🎧 หูปิดอยู่ (แตะเพื่อเปิด)" : "🎧 ปิดหู";
  $("thrMark").style.left = Math.min(100, Math.sqrt(threshold()) * 220) + "%";
  $("thrMark").style.display = mode === "vad" ? "" : "none";
  for (const [id, m] of [["mVad", "vad"], ["mPtt", "ptt"]]) $(id).classList.toggle("sel", mode === m);
}
function renderBadges() {
  const s = status, out = [];
  const add = (cls, txt) => out.push(`<span class="b ${cls}">${txt}</span>`);
  if (!engine.isOpen()) add("bad", "กำลังเชื่อมต่อใหม่…");
  else if (!s) add("warn", "รอข้อมูล…");
  else {
    add(s.gameOnline ? "ok" : "bad", s.gameOnline ? "เกมออนไลน์" : "เกมไม่ได้เชื่อม");
    add(s.inGame ? "ok" : "warn", s.inGame ? "อยู่ในเกม" : "ยังไม่เข้าเกม");
    if (!s.micEnabled) add("bad", "แอดมินปิดไมค์ทั้งเซิฟ");
    if (!s.hearEnabled) add("bad", "แอดมินปิดหูทั้งเซิฟ");
    if (s.adminMuted) add("bad", "แอดมินปิดไมค์คุณ");
    if (s.adminDeaf) add("bad", "แอดมินปิดหูคุณ");
    if (s.itemMuted) add("warn", "ปิดไมค์ด้วยไอเท็มในเกม");
    if (s.mega) add("ok", "📢 โทรโข่ง");
  }
  if (NATIVE) add("ok", "ทำงานเบื้องหลังได้");
  $("badges").innerHTML = out.join("");
}
function renderStatus() {
  const s = status;
  $("rangeTxt").textContent = "ระยะเซิฟ " + s.range + " บล็อค";
  if (s.range !== maxRange) { maxRange = s.range; renderMyRange(); }
  $("myRangeCard").classList.toggle("hidden", s.personal === false);
  renderBadges(); renderMic();
  const ul = $("nearby");
  if (!s.nearby.length) { ul.innerHTML = '<li class="hint">ไม่มีใครอยู่ในระยะ</li>'; return; }
  ul.innerHTML = s.nearby.map((n) => {
    const k = n.n.toLowerCase(), pv = personVol[k] ?? 100;
    const fx = n.lp ? (n.lp <= 500 ? " 🌊" : " 🧱") : "";
    const row = `<li data-n="${esc(k)}"><span class="tk ${n.talking ? "on" : ""}"></span><span class="nm">${esc(n.n)}${fx}${pv !== 100 ? ` <small class="hint">${pv}%</small>` : ""}</span><span class="vb"><i style="width:${n.g}%"></i></span><span class="d">${n.d} บล็อค</span></li>`;
    const ctl = openPerson === k ? `<li class="pv"><label>เสียงของ ${esc(n.n)} <span>${pv}%</span></label><input type="range" min="0" max="200" step="5" value="${pv}" data-pv="${esc(k)}"></li>` : "";
    return row + ctl;
  }).join("");
  const codec = engine.codecInfo ? engine.codecInfo() : "";
  $("codecTxt").textContent = codec ? "การส่งเสียง: " + codec + (codec === "Opus" ? " (บีบอัดสูง ใช้เน็ตน้อย)" : " (บีบอัด 4 เท่า)") : "";
}

// =====================================================================
// ปุ่มต่างๆ
// =====================================================================
$("inServer").value = server;
$("sens").value = sens; $("boost").value = boost; $("vol").value = vol;
$("boostTxt").textContent = boost + "%"; $("volTxt").textContent = vol + "%";
$("serverBox").classList.toggle("hidden", !!server);
if (SELF) $("btnShowServer").style.display = "none";
$("btnShowServer").classList.toggle("hidden", !server);
$("btnShowServer").onclick = () => { $("serverBox").classList.remove("hidden"); $("btnShowServer").classList.add("hidden"); };

function leave() { wantConnected = false; linked = false; status = null; engine.close(); engine.stopAudio(); show("scrConnect"); $("errConnect").textContent = ""; }

$("btnConnect").onclick = () => {
  server = SELF || $("inServer").value.trim();
  $("errConnect").textContent = "";
  if (!server) { $("serverBox").classList.remove("hidden"); $("errConnect").textContent = "กรอกที่อยู่เซิร์ฟเวอร์เสียง"; return; }
  store.set("server", server); renderHost(); show("scrMain");
  wantConnected = true; linked = false;
  wakeServer();
  if (!NATIVE) engine.startAudio(); // ปลดล็อกเสียงจากการแตะ (จำเป็นบนเบราว์เซอร์)
  connect();
};
function showCode() {
  show("scrLink");
  $("codeBig").textContent = pendingCode.replace(/(\d{3})(\d{3})/, "$1 $2");
  $("codeCmd").textContent = "/astra:link " + pendingCode;
}
$("btnCopyCmd").onclick = (e) => copyText("/astra:link " + pendingCode, e.currentTarget);
$("btnCopyCode").onclick = (e) => copyText(pendingCode, e.currentTarget);
$("btnNewCode").onclick = () => engine.send({ t: "newcode" });
$("btnBack").onclick = () => show("scrMain");
$("btnUseCode").onclick = () => { show("scrLink"); if (pendingCode) showCode(); else engine.send({ t: "newcode" }); };
$("inName").value = name;
$("btnLogin").onclick = () => {
  const n = $("inName").value.trim();
  if (!/^[A-Za-z0-9 _-]{1,32}$/.test(n)) { toast("กรอกชื่อ Xbox ให้ถูกต้อง (ตัวอังกฤษ ตัวเลข เว้นวรรค _ -)"); return; }
  name = n; store.set("name", n); store.set(tokenKey(), null); linked = false;
  wantConnected = true; connect(); renderAcct();
  if (!NATIVE) engine.startAudio();
};
$("inName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLogin").click(); });
function renderMyRange() {
  const v = myRange == null ? maxRange : Math.min(myRange, maxRange);
  $("myRange").max = Math.max(1, maxRange); $("myRange").value = v;
  $("myRangeTxt").textContent = v + " / " + maxRange + " บล็อค";
}
$("myRange").oninput = (e) => { myRange = +e.target.value; store.set("myRange", myRange); renderMyRange(); engine.send({ t: "range", v: myRange }); };
$("btnWaitBack").onclick = leave;
$("btnUnlink").onclick = () => {
  if (!confirm("ออกจากระบบ / เปลี่ยนชื่อ Xbox?")) return;
  store.set(tokenKey(), null);
  name = ""; store.set("name", ""); $("inName").value = ""; linked = false; status = null;
  connect(); renderAcct();
};

function setMuted(v) { muted = v; store.set("muted", v); sendState(); pushOpts(); renderMic(); }
const mic = $("btnMic");
let lastTap = 0;
mic.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  engine.startAudio();
  if (mode === "ptt") {
    const now = Date.now();
    if (now - lastTap < 350) setMuted(!muted);
    lastTap = now;
    pttDown = true; pushOpts();
  } else setMuted(!muted);
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) mic.addEventListener(ev, () => { if (pttDown) { pttDown = false; pushOpts(); } });
$("btnDeaf").onclick = () => { deaf = !deaf; sendState(); pushOpts(); renderMic(); };
$("mVad").onclick = () => { mode = "vad"; store.set("mode", mode); pushOpts(); renderMic(); };
$("mPtt").onclick = () => { mode = "ptt"; store.set("mode", mode); pushOpts(); renderMic(); };
$("sens").oninput = (e) => { sens = +e.target.value; store.set("sens", sens); pushOpts(); renderMic(); };
$("boost").oninput = (e) => { boost = +e.target.value; store.set("boost", boost); $("boostTxt").textContent = boost + "%"; pushOpts(); };
$("echo").checked = echoGate;
$("echo").onchange = (e) => { echoGate = e.target.checked; store.set("echoGate", echoGate); pushOpts(); };
$("vol").oninput = (e) => { vol = +e.target.value; store.set("vol", vol); $("volTxt").textContent = vol + "%"; pushOpts(); };

// คีย์ลัดตอนหน้าต่างแอปโฟกัส: V ค้าง = พูด, M = ปิด/เปิดไมค์
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "KeyV" && !pttDown) { pttDown = true; pushOpts(); }
  if (e.code === "KeyM" && !e.repeat) setMuted(!muted);
});
document.addEventListener("keyup", (e) => { if (e.code === "KeyV") { pttDown = false; pushOpts(); } });

// Windows: ปุ่มลัดทั่วระบบ (ใช้ได้ขณะเล่นเกม)
if (window.mcvoiceNative) {
  window.mcvoiceNative.onToggleMute(() => setMuted(!muted));
  window.mcvoiceNative.onToggleDeaf(() => $("btnDeaf").click());
  $("hotkeyHint").textContent = "ปุ่มลัดขณะเล่นเกม: F8 = ปิด/เปิดไมค์, F9 = ปิด/เปิดหู";
} else if (SELF && IS_SAFARI) {
  $("hotkeyHint").innerHTML = "📱 เว็บบน iPhone: ต้องเปิดหน้านี้ค้างไว้ (ถ้าสลับแอปหรือล็อกจอ ไมค์จะหยุด) — เหมาะกับใช้คู่กับอีกเครื่องที่เล่นเกม<br>กด แชร์ → เพิ่มไปยังหน้าจอโฮม เพื่อเปิดแบบแอป";
} else if (NATIVE) {
  $("hotkeyHint").textContent = "พับแอปไปเล่นเกมได้เลย เสียงยังทำงาน • ปิด/เปิดไมค์ได้จากแถบแจ้งเตือน";
}

// =====================================================================
// ปรับเสียงรายคน + เลือกไมค์/ลำโพง
// =====================================================================
let personVol = store.get("personVol", {}); // ชื่อ (ตัวเล็ก) → % (0-200)
function slotVolumes() {
  const m = {};
  if (status && status.nearby) for (const n of status.nearby) { const v = personVol[n.n.toLowerCase()]; if (v != null) m[n.slot] = v / 100; }
  return m;
}
let openPerson = null;
$("nearby").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-n]");
  if (!li || e.target.closest("input")) return;
  openPerson = openPerson === li.dataset.n ? null : li.dataset.n;
  renderStatus();
});
$("nearby").addEventListener("input", (e) => {
  if (!e.target.matches("input[data-pv]")) return;
  const k = e.target.dataset.pv, v = +e.target.value;
  personVol[k] = v; store.set("personVol", personVol);
  const lab = e.target.parentElement.querySelector("span"); if (lab) lab.textContent = v + "%";
  pushOpts();
});

async function loadDevices() {
  if (!engine.listDevices) return;
  const d = await engine.listDevices();
  const fill = (sel, list, cur) => {
    sel.innerHTML = '<option value="">อัตโนมัติ</option>' + list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
    sel.value = list.some((x) => x.id === cur) ? cur : "";
  };
  fill($("selIn"), d.inputs || [], store.get("inputId", ""));
  fill($("selOut"), d.outputs || [], store.get("outputId", ""));
  $("rowOut").classList.toggle("hidden", !(d.outputs || []).length);
}
$("selIn").onchange = (e) => { store.set("inputId", e.target.value); pushOpts(); };
$("selOut").onchange = (e) => { store.set("outputId", e.target.value); pushOpts(); };
$("btnRefreshDev").onclick = loadDevices;
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", loadDevices);

// =====================================================================
// เจ้าของโลก (โลกธรรมดา): คำสั่ง /wsserver + ตัวเชื่อมในเครื่อง (Windows/Android)
// =====================================================================
const BRIDGE_PORT = 19140;
const canBridge = !!(window.mcvoiceNative && window.mcvoiceNative.startBridge) || (NATIVE && CAP.getPlatform && CAP.getPlatform() === "android");
let bridgeOn = false;
function mcUrl() {
  try { const u = new URL(wsUrl(server)); return u.protocol + "//" + u.host + "/mc"; } catch { return ""; }
}
function copyText(t, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = "คัดลอกแล้ว"; setTimeout(() => (btn.textContent = o), 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => prompt("คัดลอกคำสั่งนี้", t));
  else prompt("คัดลอกคำสั่งนี้", t);
}
function renderHost() {
  const direct = "/wsserver " + mcUrl();
  const local = "/wsserver localhost:" + BRIDGE_PORT;
  const html = `
    <ol class="steps">
      <li>ในโลกต้อง <b>เปิดสูตรโกง (Cheats)</b> และคุณต้องเป็นเจ้าของโลก</li>
      <li>ตั้งค่าเกม → ทั่วไป → <b>ปิด "Require Encrypted Websockets"</b> (ทำครั้งเดียว)</li>
      <li>ใส่แพ็ก <b>Astra Nova Voice โลกธรรมดา</b> ในโลก (ไม่ใส่ก็คุยได้ แต่จะไม่มีไอเท็ม/แผงแอดมิน/ไอคอนบนหัว)</li>
      <li>คัดลอกคำสั่งนี้ไปพิมพ์ในแชทเกม <b>ทุกครั้งที่เปิดโลก</b></li>
    </ol>
    <div class="cmd"><code>${esc(direct)}</code><button data-copy="${esc(direct)}">คัดลอก</button></div>
    ${canBridge ? `<div class="hint">ถ้าพิมพ์แล้วเกมเชื่อมต่อไม่ได้ ให้ใช้ตัวเชื่อมในเครื่องนี้ (เกมต้องอยู่เครื่องเดียวกับแอปนี้)</div>
      ${bridgeOn ? `<div class="cmd"><code>${esc(local)}</code><button data-copy="${esc(local)}">คัดลอก</button></div><div class="hint">ตัวเชื่อมทำงานอยู่ — พิมพ์คำสั่งนี้ในเกมแทน</div>`
                 : `<button data-bridge style="width:100%;margin-top:8px">เปิดตัวเชื่อมในเครื่องนี้</button>`}` : ""}
    <div class="hint" style="margin-top:8px">เชื่อมสำเร็จ เกมจะขึ้นข้อความ "เชื่อมระบบเสียงกับโลกนี้แล้ว" แล้วทุกคนเปิดแอป กดคัดลอกรหัสไปวางในแชทเกมได้เลย</div>`;
  document.querySelectorAll(".hostBody").forEach((el) => {
    el.innerHTML = html;
    el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy, b)));
    const bb = el.querySelector("[data-bridge]");
    if (bb) bb.onclick = startBridge;
  });
}
async function startBridge() {
  const target = mcUrl();
  try {
    if (window.mcvoiceNative && window.mcvoiceNative.startBridge) await window.mcvoiceNative.startBridge(target, BRIDGE_PORT);
    else await VE.startBridge({ url: target, port: BRIDGE_PORT });
    bridgeOn = true; renderHost();
  } catch (e) { toast("<b>เปิดตัวเชื่อมไม่ได้</b><br>" + esc(e.message || e), 8000); }
}

renderMic();
renderHost();
// เปิดแอปแล้วเข้าหน้าไมค์ทันที — ล็อกอินทีหลังได้
if (server) {
  show("scrMain"); wantConnected = true; wakeServer(); connect(); renderAcct(); renderMyRange();
  if (NATIVE) engine.startAudio();
  else document.addEventListener("pointerdown", function once() { document.removeEventListener("pointerdown", once, true); engine.startAudio().then?.(() => { pushOpts(); loadDevices(); }); }, true);
} else show("scrConnect");
