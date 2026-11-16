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
const SELF = !NATIVE && !window.mcvoiceNative && /^https?:$/.test(location.protocol) ? location.origin : "";
let server = SELF || store.get("server", "") || CFG.serverUrl || "", name = store.get("name", "");
let echoGate = store.get("echoGate", true);
const IS_SAFARI = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) || /iP(hone|ad|od)/.test(navigator.userAgent);
let muted = store.get("muted", false), deaf = false;
let mode = store.get("mode", "vad"), pttDown = false;
let sens = store.get("sens", 60), boost = store.get("boost", 100), vol = store.get("vol", 100);
let status = null;

// ---------- helpers ----------
function show(scr) {
  for (const s of ["scrConnect", "scrVerify", "scrWait", "scrMain"]) $(s).classList.toggle("hidden", s !== scr);
  $("topbar").classList.toggle("hidden", scr !== "scrMain");
}
function toast(html, ms = 6000) { const t = $("toast"); t.innerHTML = html; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), ms); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tokenKey = () => "token:" + server.toLowerCase() + ":" + name.toLowerCase();
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

function nativeEngine() {
  VE.addListener("event", (ev) => {
    switch (ev.type) {
      case "open": onOpen(); break;
      case "close": onClose(); break;
      case "msg": try { onMsg(JSON.parse(ev.data)); } catch {} break;
      case "level": onLevel(ev.rms, ev.tx); break;
      case "mute": muted = !!ev.muted; store.set("muted", muted); sendState(); renderMic(); break; // กดจากแจ้งเตือน
      case "stopReq": wantConnected = false; linked = false; store.set("auto", false); show("scrConnect"); break;
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
  };
}

function webEngine() {
  let ws = null, url = null, hello = null, reconnectTimer = null;
  let ctx = null, micStream = null, capNode = null, boostNode = null, master = null, audioBusy = null;
  const speakers = new Map();
  let opts = {}, hangUntil = 0, preroll = null, transmitting = false;
  let remoteLvl = 0, remoteUntil = 0, wakeLock = null, aecRouted = false;

  // ส่งเสียงที่เล่นออกลำโพงผ่าน WebRTC loopback → ตัวตัดเสียงสะท้อน (AEC) ของ Chrome/Windows
  // จะรู้ว่าเราเล่นอะไรออกไป แล้วลบออกจากไมค์ได้ (Safari/iPhone ระบบตัดให้เองอยู่แล้ว)
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
    return { a, b, el };
  }

  function open() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (ev) => { if (typeof ev.data !== "string") return play(ev.data); try { onMsg(JSON.parse(ev.data)); } catch {} };
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

  async function start() {
    try {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        master = ctx.createGain(); master.gain.value = opts.deaf ? 0 : (opts.vol ?? 1);
        let routed = false;
        if (!IS_SAFARI && window.RTCPeerConnection && ctx.createMediaStreamDestination) {
          try { const dest = ctx.createMediaStreamDestination(); master.connect(dest); await loopbackOut(dest.stream); routed = true; }
          catch (e) { console.warn("AEC loopback ไม่ได้", e); }
        }
        if (!routed) master.connect(ctx.destination);
        aecRouted = routed;
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      }
      if (ctx.state !== "running") ctx.resume().catch(() => {});
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const src = ctx.createMediaStreamSource(micStream);
        boostNode = ctx.createGain(); boostNode.gain.value = opts.boost ?? 1;
        capNode = new AudioWorkletNode(ctx, "mcv-cap");
        const sink = ctx.createGain(); sink.gain.value = 0;
        src.connect(boostNode).connect(capNode).connect(sink).connect(ctx.destination);
        capNode.port.onmessage = (e) => capture(e.data);
      }
      try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
      setTimeout(() => { if (ctx && ctx.state !== "running") toast("แตะปุ่มไมค์หนึ่งครั้งเพื่อเริ่มเสียง", 5000); }, 800);
    } catch (e) {
      toast("<b>ใช้ไมค์ไม่ได้</b><br>" + esc(e.message || e) + "<br>กรุณาอนุญาตการใช้ไมโครโฟน", 12000);
    }
  }

  function capture({ pcm, rms }) {
    let tx = false;
    if (opts.active && !opts.muted && ws && ws.readyState === 1) {
      if (opts.ptt) tx = !!opts.pttDown;
      else {
        const now = performance.now();
        let th = opts.threshold ?? 0.02;
        // กันเสียงสะท้อน: ขณะได้ยินคนอื่นพูด ต้องพูดดังกว่าเสียงที่ย้อนเข้าไมค์จึงจะส่ง
        if (opts.echoGate && now < remoteUntil) th = Math.max(th * 3, remoteLvl * 0.6);
        if (rms > th) hangUntil = now + 450;
        tx = now < hangUntil;
      }
    }
    if (tx) { if (!transmitting && preroll && !opts.ptt) ws.send(preroll); ws.send(pcm); }
    preroll = pcm; transmitting = tx;
    onLevel(rms, tx);
  }

  function play(buf) {
    if (!ctx || opts.deaf || buf.byteLength < 6) return;
    const dv = new DataView(buf);
    const slot = dv.getUint16(0, true), g = dv.getUint8(2) / 255, pan = dv.getInt8(3) / 127;
    const pcm = new Int16Array(buf, 4, (buf.byteLength - 4) >> 1);
    let sp = speakers.get(slot);
    if (!sp) {
      const gain = ctx.createGain(); gain.gain.value = g;
      let out = gain, panner = null;
      if (ctx.createStereoPanner) { panner = ctx.createStereoPanner(); gain.connect(panner); out = panner; }
      out.connect(master);
      sp = { gain, panner, next: 0 }; speakers.set(slot, sp);
    }
    const t = ctx.currentTime;
    sp.gain.gain.setTargetAtTime(g, t, 0.06);
    if (sp.panner) sp.panner.pan.setTargetAtTime(pan, t, 0.08);
    const ab = ctx.createBuffer(1, pcm.length, RATE);
    const ch = ab.getChannelData(0);
    let sq = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; ch[i] = v; sq += v * v; }
    const lvl = Math.sqrt(sq / pcm.length) * g * (opts.vol ?? 1);
    const nowMs = performance.now();
    remoteLvl = nowMs < remoteUntil ? Math.max(remoteLvl * 0.9, lvl) : lvl;
    remoteUntil = nowMs + 250;
    const src = ctx.createBufferSource(); src.buffer = ab; src.connect(sp.gain);
    if (sp.next < t + 0.015 || sp.next > t + 0.45) sp.next = t + 0.09;
    src.start(sp.next); sp.next += ab.duration;
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
      if (capNode) { capNode.port.onmessage = null; capNode.disconnect(); capNode = null; }
    },
    setOpts(o) {
      Object.assign(opts, o);
      if (master) master.gain.value = opts.deaf ? 0 : (opts.vol ?? 1);
      if (boostNode) boostNode.gain.value = opts.boost ?? 1;
    },
    debug: () => ({ speakers: speakers.size, aecRouted, remoteLvl, ctx: ctx && ctx.state }),
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
  });
}

// =====================================================================
// โปรโตคอลกับเซิร์ฟเวอร์เสียง
// =====================================================================
function connect() {
  let url;
  try { url = wsUrl(server); new URL(url); } catch { $("errConnect").textContent = "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง"; return; }
  $("errConnect").textContent = "กำลังเชื่อมต่อ…";
  Promise.resolve(engine.connect(url, { t: "hello", name, token: store.get(tokenKey(), null) }))
    .catch((e) => { $("errConnect").textContent = "เชื่อมต่อไม่ได้: " + (e.message || e); });
}

function handleClose() {
  $("dot").classList.remove("on");
  if (!wantConnected) return;
  if (!linked && $("scrWait").classList.contains("hidden")) {
    $("errConnect").textContent = "เชื่อมต่อเซิร์ฟเวอร์เสียงไม่ได้ (ถ้าใช้ Render อาจกำลังตื่น รอ 30 วิแล้วลองใหม่)";
    show("scrConnect"); wantConnected = false; engine.close();
  }
  renderBadges();
}

function onMsg(m) {
  switch (m.t) {
    case "waiting":
      show("scrWait");
      $("waitTitle").textContent = m.gameOnline ? "รอ " + name + " เข้าเกม…" : "เซิฟมายคราฟยังไม่ได้เชื่อมกับระบบเสียง";
      $("waitHint").innerHTML = m.gameOnline
        ? "เข้าเซิฟมายคราฟด้วยชื่อ Xbox <b>" + esc(name) + "</b> แล้วจะลิงก์ให้อัตโนมัติ<br>(ตัวพิมพ์เล็ก/ใหญ่ไม่มีผล)"
        : "โลกธรรมดา: ให้เจ้าของโลกพิมพ์คำสั่ง /wsserver ด้านล่างในเกม • เซิฟ BDS: ให้แอดมินตรวจแอดออน";
      break;
    case "code_sent":
      show("scrVerify");
      $("verifyHint").innerHTML = m.online ? "ดูรหัส 6 หลักกลางจอ/ในแชทของ <b>" + esc(name) + "</b>" : "เข้าเกมด้วยชื่อ <b>" + esc(name) + "</b> แล้วรหัสจะเด้งขึ้นเอง";
      $("inCode").value = "";
      break;
    case "verify_fail": $("errVerify").textContent = m.msg; break;
    case "linked":
      linked = true;
      if (m.token) store.set(tokenKey(), m.token);
      store.set("auto", true);
      $("dot").classList.add("on");
      $("meName").textContent = m.name;
      show("scrMain");
      Promise.resolve(engine.startAudio()).then(() => { pushOpts(); sendState(); });
      break;
    case "status": status = m; $("dot").classList.add("on"); renderStatus(); pushOpts(); break;
    case "announce":
      toast("<b>📢 ประกาศ</b>" + (m.by ? " <span style='opacity:.7'>(" + esc(m.by) + ")</span>" : "") + "<br>" + esc(m.text), 10000);
      engine.beep && engine.beep();
      break;
    case "kicked": wantConnected = false; linked = false; toast(esc(m.reason)); show("scrConnect"); engine.close(); engine.stopAudio(); break;
    case "error": $("errConnect").textContent = m.msg; show("scrConnect"); wantConnected = false; engine.close(); break;
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
  $("rangeTxt").textContent = "ระยะ " + s.range + " บล็อค";
  renderBadges(); renderMic();
  const ul = $("nearby");
  if (!s.nearby.length) { ul.innerHTML = '<li class="hint">ไม่มีใครอยู่ในระยะ</li>'; return; }
  ul.innerHTML = s.nearby.map((n) => `<li><span class="tk ${n.talking ? "on" : ""}"></span><span class="nm">${esc(n.n)}</span><span class="vb"><i style="width:${n.g}%"></i></span><span class="d">${n.d} บล็อค</span></li>`).join("");
}

// =====================================================================
// ปุ่มต่างๆ
// =====================================================================
$("inServer").value = server; $("inName").value = name;
$("sens").value = sens; $("boost").value = boost; $("vol").value = vol;
$("boostTxt").textContent = boost + "%"; $("volTxt").textContent = vol + "%";
$("serverBox").classList.toggle("hidden", !!server);
if (SELF) $("btnShowServer").style.display = "none";
$("btnShowServer").classList.toggle("hidden", !server);
$("btnShowServer").onclick = () => { $("serverBox").classList.remove("hidden"); $("btnShowServer").classList.add("hidden"); };

function leave() { wantConnected = false; linked = false; status = null; engine.close(); engine.stopAudio(); show("scrConnect"); $("errConnect").textContent = ""; }

$("btnConnect").onclick = () => {
  server = SELF || $("inServer").value.trim(); name = $("inName").value.trim();
  $("errConnect").textContent = "";
  if (!server) { $("serverBox").classList.remove("hidden"); $("errConnect").textContent = "กรอกที่อยู่เซิร์ฟเวอร์เสียง"; return; }
  if (!/^[A-Za-z0-9 _-]{1,32}$/.test(name)) { $("errConnect").textContent = "กรอกชื่อ Xbox ให้ถูกต้อง"; return; }
  store.set("server", server); store.set("name", name); renderHost();
  wantConnected = true; linked = false;
  if (!NATIVE) engine.startAudio(); // ปลดล็อกเสียงจากการแตะ (จำเป็นบนเบราว์เซอร์)
  connect();
};
$("btnVerify").onclick = () => { $("errVerify").textContent = ""; engine.send({ t: "verify", code: $("inCode").value.trim() }); };
$("inCode").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); if (e.target.value.length === 6) $("btnVerify").click(); });
$("btnResend").onclick = () => engine.send({ t: "resend" });
$("btnBack").onclick = leave;
$("btnWaitBack").onclick = leave;
$("btnLogout").onclick = () => { store.set("auto", false); leave(); };
$("btnUnlink").onclick = () => {
  if (!confirm("ออกและล้างชื่อที่จำไว้ในเครื่องนี้?")) return;
  engine.send({ t: "unlink", token: store.get(tokenKey(), null) }); store.set(tokenKey(), null); store.set("auto", false);
  name = ""; store.set("name", ""); $("inName").value = "";
  leave();
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
    <div class="hint" style="margin-top:8px">เชื่อมสำเร็จ เกมจะขึ้นข้อความ "เชื่อมระบบเสียงกับโลกนี้แล้ว" แล้วเพื่อนเปิดแอปใส่ชื่อ Xbox ได้เลย</div>`;
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
if (server && name && store.get("auto", false)) { wantConnected = true; connect(); } // เข้าอัตโนมัติ
