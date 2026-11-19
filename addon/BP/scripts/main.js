import { world, system, ItemStack, MolangVariableMap, EquipmentSlot, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { VOICE_CATS, VOICES } from "./voices.js";

const MIC_ITEM = "voice:mic_toggle";
const ADMIN_ITEM = "voice:admin_panel";
const DP_KEY = "mcvoice:state";
const APP = "§dAstra Nova Voice§r";
const TALK_SUFFIX = "\n§a((♪))";
const MIC_GLYPH = "\uE100"; // ไอคอนไมค์ในป้ายชื่อ (RP font/glyph_E1.png)
const MUTE_GLYPH = "\uE101"; // ไมค์ปิด
const DEAF_GLYPH = "\uE102"; // ปิดหู
const UI = (n) => "textures/astra_ui/" + n;
const STYLES = ["ไอคอนลอยเหนือหัว", "ไอคอนข้างชื่อ", "ไอคอนใต้ชื่อ", "ไม่แสดง"];

// ไฟล์นี้คือแกนกลาง ใช้ร่วมกันทั้ง 2 แบบ:
//  - entry_server.js : เซิฟ BDS (เช่น mcsv) ส่งข้อมูลผ่าน @minecraft/server-net
//  - entry_world.js  : โลกธรรมดา เจ้าของโลกพิมพ์ /wsserver แล้วระบบเสียงคุยกับแอดออนผ่าน /scriptevent
let transport = { mode: "server", start() {} };

// ---------------- state ----------------
const S = {
  range: CONFIG.defaultRange,
  micEnabled: true, // ไมค์ทั้งเซิฟ
  hearEnabled: true, // หูทั้งเซิฟ
  showTalking: true, // ไอคอนไมค์ลอยบนหัวคนที่กำลังพูด (ทุกคนเห็น)
  showTalkTag: false, // ต่อท้ายชื่อด้วย ((♪)) ตอนพูด
  // กำแพงกั้นเสียง + เอฟเฟกต์ (ตั้งได้ในแผงแอดมิน)
  occEnabled: true, // เปิดระบบกำแพงกั้นเสียง
  occThin: 1,       // ผนังกี่บล็อค = เสียงอู้เล็กน้อย
  occThick: 3,      // ผนังกี่บล็อค = เสียงอู้มาก
  occBlock: 0,      // ผนังกี่บล็อค = ไม่ได้ยินเลย (0 = ไม่ตัดเสียง)
  waterEnabled: true, // ใต้น้ำเสียงอู้
  stereo: true,     // เสียงซ้าย/ขวาตามทิศ
  personal: true,   // ผู้เล่นปรับระยะพูดของตัวเองในแอปได้
  falloff: 0,       // 0 ธรรมชาติ, 1 เส้นตรง, 2 ดังเท่ากันทั้งระยะ
  muted: new Set(), // แอดมินปิดไมค์รายคน (ชื่อตัวเล็ก)
  deaf: new Set(), // แอดมินปิดหูรายคน
  mega: new Set(), // โทรโข่ง: พูดแล้วได้ยินทั้งเซิฟ
  self: new Set(), // ผู้เล่นปิดไมค์ตัวเองด้วยไอเท็ม
  vfx: new Map(), // เปลี่ยนเสียง (แอดมินเท่านั้น): ชื่อตัวเล็ก -> แบบเสียง
  prange: new Map(), // ระยะพูดที่ผู้เล่นตั้งเองในเกม: ชื่อตัวเล็ก -> บล็อค
  style: new Map(), // แบบที่ผู้เล่นคนนั้น "เห็น" สัญลักษณ์ของทุกคน (เห็นแค่ตัวเอง)
  side: new Map(), // แจ้งเตือนข้างจอ เปิด/ปิด (ค่าเริ่มต้น ปิด)
  selfDeaf: new Set(), // ปิดหูตัวเอง
  holdAll: false, // แอดมินบังคับ: ทุกคนต้องถือไอเท็มไมค์ถึงพูดได้
  holdSelf: new Set(), // ผู้เล่นที่เปิดโหมดถือไมค์เอง (สายโรล)
  defStyle: 0, // สัญลักษณ์เริ่มต้นของเซิฟ
};
let announceQueue = [];
let busy = false;
let online = false;
let lastOkTick = 0;
let linkedSet = new Set();
// คำขอลิงก์จากคำสั่ง /astra:link รหัส : key(ชื่อ) -> { n, code, until }
const claims = new Map();
let talkingSet = new Set();
let nearbyInfo = {};
const lastToggle = new Map();
const origNameTag = new Map();

const key = (name) => String(name).replace(/§./g, "").replace(/\[[^\]]*\]/g, "").trim().toLowerCase();

function save() {
  mirrorState();
  try {
    world.setDynamicProperty(
      DP_KEY,
      JSON.stringify({
        range: S.range, micEnabled: S.micEnabled, hearEnabled: S.hearEnabled, showTalking: S.showTalking, showTalkTag: S.showTalkTag,
        ...Object.fromEntries(["occEnabled", "occThin", "occThick", "occBlock", "waterEnabled", "stereo", "personal", "falloff"].map((k) => [k, S[k]])),
        muted: [...S.muted], deaf: [...S.deaf], mega: [...S.mega], self: [...S.self],
        vfx: Object.fromEntries(S.vfx),
        prange: Object.fromEntries(S.prange),
        style: Object.fromEntries(S.style), side: Object.fromEntries(S.side), selfDeaf: [...S.selfDeaf], defStyle: S.defStyle, holdAll: S.holdAll, holdSelf: [...S.holdSelf],
      })
    );
  } catch (e) { console.warn("[MCVoice] save failed " + e); }
}
function load() {
  try {
    const raw = world.getDynamicProperty(DP_KEY);
    if (typeof raw !== "string") return;
    const o = JSON.parse(raw);
    if (typeof o.range === "number") S.range = clampRange(o.range);
    for (const k of ["micEnabled", "hearEnabled", "showTalking", "showTalkTag"]) if (typeof o[k] === "boolean") S[k] = o[k];
    for (const k of ["occEnabled", "occThin", "occThick", "occBlock", "waterEnabled", "stereo", "personal", "falloff"]) if (typeof o[k] === typeof S[k]) S[k] = o[k];
    for (const k of ["muted", "deaf", "mega", "self"]) if (Array.isArray(o[k])) S[k] = new Set(o[k]);
    if (o.style && typeof o.style === "object") S.style = new Map(Object.entries(o.style).map(([k, v]) => [k, Number(v) || 0]));
    if (o.side && typeof o.side === "object") S.side = new Map(Object.entries(o.side).map(([k, v]) => [k, !!v]));
    if (Array.isArray(o.selfDeaf)) S.selfDeaf = new Set(o.selfDeaf);
    if (typeof o.holdAll === "boolean") S.holdAll = o.holdAll;
    if (Array.isArray(o.holdSelf)) S.holdSelf = new Set(o.holdSelf);
    if (typeof o.defStyle === "number") S.defStyle = o.defStyle; else if (o.showTalkTag) S.defStyle = 2;
    if (o.prange && typeof o.prange === "object") S.prange = new Map(Object.entries(o.prange).map(([k, v]) => [k, Number(v) || 0]));
    if (o.vfx && typeof o.vfx === "object") S.vfx = new Map(Object.entries(o.vfx).map(([k, v]) => [k, Number(v) || 0]));
  } catch (e) { console.warn("[MCVoice] load failed " + e); }
}
const clampRange = (v) => Math.max(0, Math.min(CONFIG.maxRange, Math.round(Number(v) || 0)));

function isAdmin(p) {
  if (p.hasTag(CONFIG.adminTag)) return true;
  try { return Number(p.playerPermissionLevel) >= 2; } catch { return false; }
}
const admins = () => world.getAllPlayers().filter(isAdmin);
const findPlayer = (name) => world.getAllPlayers().find((p) => key(p.name) === key(name));
const onoff = (b) => (b ? "§aเปิด" : "§cปิด");

// ---------------- sync กับ voice server ----------------
// คนที่ออกจากเกมจริง: บอกเซิฟเวอร์เสียงให้ลบทันที (ส่งซ้ำได้ 10 วิ เผื่อรอบไหนส่งไม่ถึง)
const recentLeft = new Map();
try { world.afterEvents.playerLeave.subscribe((e) => recentLeft.set(e.playerName, Date.now())); } catch { /* API เก่า */ }
function buildPayload() {
  const players = [];
  for (const p of world.getAllPlayers()) {
    try {
      const l = p.location, r = p.getRotation();
      players.push({
        n: p.name, x: +l.x.toFixed(2), y: +l.y.toFixed(2), z: +l.z.toFixed(2),
        d: p.dimension.id, yaw: +r.y.toFixed(1), w: env.water.has(key(p.name)) ? 1 : 0,
      });
    } catch { /* ผู้เล่นกำลังโหลด */ }
  }
  return {
    secret: CONFIG.secret,
    settings: { range: S.range, micEnabled: S.micEnabled, hearEnabled: S.hearEnabled, stereo: S.stereo, personal: S.personal, falloff: S.falloff },
    muted: [...S.muted], deaf: [...new Set([...S.deaf, ...S.selfDeaf])], mega: [...S.mega], self: [...new Set([...S.self, ...holdMuted])],
    players,
    claims: [...claims.values()].map((c) => [c.n, c.code]),
    vfx: vfxNow(),
    prange: prangeNow(),
    occ: env.occ,
    announce: announceQueue,
    left: [...recentLeft].filter(([n, t]) => Date.now() - t < 10000 || !recentLeft.delete(n)).map(([n]) => n)
      .filter((n) => !players.some((x) => x.n === n)),
  };
}

// รายชื่อเสียง (สูตรเสียงจริงอยู่ที่เซิร์ฟเวอร์ — แอปทำตามสูตรที่เซิร์ฟเวอร์ส่งไป)
const VOICE_BY_ID = new Map(VOICES.map((v) => [v.id, v]));
const VMAX = Math.max(...VOICES.map((v) => v.id));
const vfxName = (id) => (VOICE_BY_ID.get(id) || VOICE_BY_ID.get(0)).n;
// สิทธิ์เปลี่ยนเสียง: OP / แท็กแอดมิน / แท็ก "ad" = ทุกเสียง, แท็ก "mic" = เฉพาะ 12 เสียงพื้นฐาน (ชุดเดิม)
const BASIC_MAX = 12;
function vfxLevel(p) {
  try {
    if (isAdmin(p) || p.hasTag("ad")) return 2;
    if (p.hasTag("mic")) return 1;
  } catch {}
  return 0;
}
const vfxAllowed = (lvl, id) => !id || (VOICE_BY_ID.has(id) && (lvl >= 2 || (lvl === 1 && id <= BASIC_MAX)));
function vfxNow() {
  const out = {};
  for (const p of world.getAllPlayers()) { const v = S.vfx.get(key(p.name)); if (v && vfxAllowed(vfxLevel(p), v)) out[p.name] = v; }
  return out;
}
function setVfx(p, v) {
  const k = key(p.name);
  if (v) S.vfx.set(k, v); else S.vfx.delete(k);
  save();
  p.sendMessage(`§d[ไมค์] §fเปลี่ยนเสียงเป็น §e${vfxName(v)}§7 (มีผลในแอปภายใน 1-2 วินาที — แอปต้องเป็นรุ่น 2.0 ขึ้นไป)`);
  if (transport.mode === "world") mirrorState();
  p.playSound("random.orb", { pitch: 1.2 });
}
// เมนูเปลี่ยนเสียง: เลือกหมวด → เลือกเสียง
function vfxForm(p) {
  const lvl = vfxLevel(p);
  if (!lvl) return p.sendMessage("§c[ไมค์] คุณไม่มีสิทธิ์เปลี่ยนเสียง §7(ต้องมีแท็ก mic หรือ ad หรือเป็นแอดมิน)");
  const cur = S.vfx.get(key(p.name)) || 0;
  const curCat = (VOICE_BY_ID.get(cur) || { c: -1 }).c;
  const allowed = VOICES.filter((v) => v.id && vfxAllowed(lvl, v.id));
  const cats = VOICE_CATS.map((c, i) => ({ c, i, n: allowed.filter((v) => v.c === i).length })).filter((x) => x.n);
  const f = new ActionFormData()
    .title(`§l§dเปลี่ยนเสียง §7(${lvl >= 2 ? "ทุกเสียง" : "เสียงพื้นฐาน"})`)
    .body(`เสียงของคุณตอนนี้: §e${vfxName(cur)}§r\nเลือกหมวดเสียง (ใช้ได้ ${allowed.length} เสียง)` +
      (lvl === 1 ? "\n§7แท็ก mic ใช้ได้เฉพาะเสียงพื้นฐาน — แท็ก ad ใช้ได้ทุกเสียง" : ""));
  f.button(cur ? "§aกลับเป็นเสียงปกติ" : "§7เสียงปกติ §8(ใช้อยู่)", UI("mic_on"));
  for (const x of cats) f.button(`${x.i === curCat ? "§e▶ " : ""}${x.c} §8(${x.n})`, UI(["players", "style", "items", "ear_off", "walls", "admin", "vfx"][x.i] || "vfx"));
  f.show(p).then((r) => {
    if (r.canceled) return;
    if (r.selection === 0) return setVfx(p, 0);
    voiceCatForm(p, cats[r.selection - 1].i);
  });
}
function voiceCatForm(p, ci) {
  const cur = S.vfx.get(key(p.name)) || 0, lvl = vfxLevel(p);
  const list = VOICES.filter((v) => v.c === ci && v.id && vfxAllowed(lvl, v.id));
  const f = new ActionFormData().title(`§l§d${VOICE_CATS[ci]}`).body("แตะเพื่อใช้เสียงนั้นทันที");
  for (const v of list) f.button(v.id === cur ? `§a✔ ${v.n} §8(ใช้อยู่)` : v.n, UI("vfx"));
  f.button("« กลับ", UI("back"));
  f.show(p).then((r) => {
    if (r.canceled) return;
    if (r.selection === list.length) return vfxForm(p);
    if (!vfxAllowed(vfxLevel(p), list[r.selection].id)) return p.sendMessage("§c[ไมค์] คุณไม่มีสิทธิ์ใช้เสียงนี้");
    setVfx(p, list[r.selection].id);
  });
}

// ---------------- ใต้น้ำ + ผนังกั้นเสียง ----------------
const env = { water: new Set(), occ: {} }; // occ: "a|b" -> 1 (บาง) / 2 (หนา)
const PASSABLE = /(air|water|lava|grass|fern|flower|torch|sapling|vine|carpet|button|lever|sign|rail|bush|snow_layer|dandelion|poppy|tulip|orchid|allium|bluet|daisy|ladder|banner|pressure_plate|tripwire|redstone_wire|fire|light_block|structure_void|cobweb|kelp|seagrass|coral_fan|lantern|candle|frame|pointed_dripstone|scaffolding|glow_lichen|moss_carpet|petals|lily_pad|mushroom|wheat|carrots|potatoes|beetroot|sugar_cane|dead_bush|hanging_roots|spore_blossom|azalea_leaves_flowered)/;
function solidAt(dim, x, y, z) {
  try {
    const b = dim.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
    if (!b || b.isAir || b.isLiquid) return false;
    return !PASSABLE.test(b.typeId);
  } catch { return false; }
}
function countWalls(dim, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(dist / 0.5);
  let count = 0, last = "";
  const max = Math.max(S.occThin, S.occThick, S.occBlock || 0);
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    const k = Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z);
    if (k === last) continue;
    last = k;
    if (solidAt(dim, x, y, z) && ++count >= max) break;
  }
  if (S.occBlock > 0 && count >= S.occBlock) return 3; // ไม่ได้ยินเลย
  return count >= S.occThick ? 2 : count >= S.occThin ? 1 : 0;
}
function updateEnv() {
  const ps = world.getAllPlayers();
  const water = new Set(), heads = [];
  for (const p of ps) {
    try {
      const h = p.getHeadLocation();
      const b = p.dimension.getBlock({ x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) });
      const headWet = b && (b.typeId.includes("water") || (b.isWaterlogged ?? false));
      if (S.waterEnabled && (headWet || p.isSwimming)) water.add(key(p.name));
      heads.push({ k: key(p.name), d: p.dimension, h });
    } catch { /* ignore */ }
  }
  const occ = {}, R = Math.min(S.range, 48);
  for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) {
    const a = heads[i], b = heads[j];
    if (!S.occEnabled) break;
    if (a.d.id !== b.d.id || Math.hypot(a.h.x - b.h.x, a.h.y - b.h.y, a.h.z - b.h.z) > R) continue;
    const lvl = countWalls(a.d, a.h, b.h);
    if (lvl) occ[[a.k, b.k].sort().join("|")] = lvl;
  }
  env.water = water; env.occ = occ;
  if (transport.mode === "world") {
    for (const p of ps) { try { if (water.has(key(p.name))) p.addTag("astra_water"); else p.removeTag("astra_water"); } catch {} }
    const vf = vfxNow();
    let vObj = null;
    try { vObj = world.scoreboard.getObjective("astra_vfx") ?? world.scoreboard.addObjective("astra_vfx", "Astra Voice FX"); } catch {}
    for (const p of ps) {
      try {
        const v = vf[p.name] || 0;
        if (v) { p.addTag("astra_vfx"); if (vObj && vObj.getScore(p) !== v) vObj.setScore(p, v); }
        else if (p.hasTag("astra_vfx")) p.removeTag("astra_vfx");
        for (const t of p.getTags()) if (t.startsWith("astra_vfx_")) p.removeTag(t); // แท็กแบบเก่า (รุ่นก่อน 2.0)
      } catch {}
    }
    try {
      const sb = world.scoreboard;
      const obj = sb.getObjective("astra_occ") ?? sb.addObjective("astra_occ", "Astra Walls");
      const keep = new Set(Object.keys(occ));
      for (const pt of obj.getParticipants()) if (!keep.has(pt.displayName)) obj.removeParticipant(pt);
      for (const [k, v] of Object.entries(occ)) obj.setScore(k, v);
    } catch (e) { /* scoreboard not ready */ }
  }
}

// ใช้โดย transport
export const core = {
  buildPayload,
  handleResponse: (r) => handleResponse(r),
  takeAnnouncements() { const a = announceQueue; announceQueue = []; return a; },
  returnAnnouncements(a) { announceQueue = a.concat(announceQueue); },
  setOnline(v, reason) {
    if (v === online) return;
    online = v;
    for (const a of admins()) a.sendMessage(v ? "§a[ไมค์] เชื่อมต่อระบบเสียงสำเร็จ" : "§c[ไมค์] ขาดการเชื่อมต่อระบบเสียง" + (reason ? ": " + reason : ""));
  },
};

// โหมดโลกธรรมดา: เก็บค่าไว้ใน tag/scoreboard ให้ระบบเสียงอ่านผ่าน /wsserver
function mirrorState() {
  if (transport.mode !== "world") return;
  try {
    const sb = world.scoreboard;
    const obj = sb.getObjective("astra") ?? sb.addObjective("astra", "Astra Voice");
    obj.setScore("astra_cfg", S.range * 4 + (S.micEnabled ? 2 : 0) + (S.hearEnabled ? 1 : 0));
    obj.setScore("astra_fx", (S.stereo ? 1 : 0) + (S.personal ? 2 : 0) + S.falloff * 4);
    obj.setScore("astra_prv", prVersion);
    const pr = sb.getObjective("astra_pr") ?? sb.addObjective("astra_pr", "Astra Range");
    for (const p of world.getAllPlayers()) { const v = S.prange.get(key(p.name)); try { if (v) pr.setScore(p, v); else pr.removeParticipant(p); } catch {} }
  } catch (e) { console.warn("[MCVoice] scoreboard " + e); }
  for (const p of world.getAllPlayers()) mirrorPlayer(p);
}
function mirrorPlayer(p) {
  if (transport.mode !== "world") return;
  const k = key(p.name);
  const deafAll = new Set([...S.deaf, ...S.selfDeaf]);
  const selfAll = new Set([...S.self, ...holdMuted]);
  for (const [set, tag] of [[S.muted, "astra_muted"], [deafAll, "astra_deaf"], [S.mega, "astra_mega"], [selfAll, "astra_self"]]) {
    try { if (set.has(k)) p.addTag(tag); else p.removeTag(tag); } catch { /* ignore */ }
  }
}

function handleResponse(r) {
  // ส่งรหัสยืนยันให้ผู้เล่น (เห็นคนเดียว)
  for (const l of r.links ?? []) {
    const p = findPlayer(l.n);
    if (!p) continue;
    p.sendMessage(`§e[ไมค์] §fมีคำขอเชื่อมแอปไมค์กับชื่อ §b${p.name}\n§fรหัสยืนยันของคุณ: §a§l${l.code}§r\n§7พิมพ์รหัสนี้ในแอป (อย่าบอกใคร) ถ้าไม่ได้ขอเอง ให้เพิกเฉย`);
    holdSide(p, 140);
    p.onScreenDisplay.setTitle(`§a${l.code}`, { subtitle: "§fรหัสยืนยันแอปไมค์", fadeInDuration: 5, stayDuration: 100, fadeOutDuration: 10 });
  }
  for (const n of r.justLinked ?? []) {
    clearClaim(key(n));
    const p = findPlayer(n);
    if (p) { p.sendMessage("§a[ไมค์] เชื่อมแอปสำเร็จ! คุยกับคนรอบตัวได้แล้ว"); p.playSound("random.levelup"); }
  }
  linkedSet = new Set((r.linked ?? []).map(key));
  talkingSet = new Set((r.talking ?? []).map(key));
  nearbyInfo = r.nearby ?? {};
  updateNameTags();
}

const decorated = new Map();
const styleOf = (k) => (S.style.has(k) ? S.style.get(k) : S.defStyle);
const sideOf = (k) => S.side.get(k) === true; // ค่าเริ่มต้นปิด — ขึ้นเฉพาะคนที่เปิดเองในเมนูไมค์
// เวอร์ชันก่อนเขียนรูปลงป้ายชื่อ (ทุกคนเห็นเหมือนกัน) — ตอนนี้ใช้พาร์ติเคิลที่เห็นเฉพาะคนดูแทน จึงแค่คืนป้ายชื่อเดิม
function updateNameTags() {
  if (!decorated.size) return;
  for (const p of world.getAllPlayers()) {
    const k = key(p.name);
    if (!decorated.has(k)) continue;
    try { if (p.nameTag === decorated.get(k)) p.nameTag = origNameTag.get(k) ?? p.name; } catch {}
    decorated.delete(k); origNameTag.delete(k);
  }
}

// ส่งพาร์ติเคิลให้ผู้เล่นคนเดียวเห็น (ถ้าเวอร์ชันเกมไม่รองรับ ทุกคนจะเห็น)
function spawnFor(viewer, id, at, vars) {
  try {
    if (typeof viewer.spawnParticle === "function") viewer.spawnParticle(id, at, vars);
    else viewer.dimension.spawnParticle(id, at, vars);
  } catch { /* chunk ยังไม่โหลด */ }
}

// ---------------- สัญลักษณ์ไมค์ (กำลังพูด / ปิดไมค์ / ปิดหู) ----------------
// ผู้เล่นแต่ละคนเลือกเองว่าจะ "เห็น" สัญลักษณ์ของทุกคนในเซิฟแบบไหน — เห็นแค่ตัวเอง ไม่กระทบคนอื่น
let talkFrame = 0;
function drawIndicators() {
  if (!S.showTalking) return;
  const ps = world.getAllPlayers();
  const who = [];
  for (const s of ps) {
    const k = key(s.name);
    const talk = talkingSet.has(k), mute = S.self.has(k) || S.muted.has(k), deaf = S.selfDeaf.has(k) || S.deaf.has(k);
    if (!talk && !mute && !deaf) continue;
    try { who.push({ s, h: s.getHeadLocation(), dim: s.dimension.id, sneak: s.isSneaking, len: s.name.length,
      id: talk ? "astra:talking" : mute ? "astra:muted" : "astra:deafened" }); } catch {}
  }
  if (!who.length) return;
  talkFrame = (talkFrame + 0.75) % 4;
  const vars = new MolangVariableMap();
  vars.setFloat("variable.frame", talkFrame);
  for (const v of ps) {
    const st = styleOf(key(v.name));
    if (st === 3) continue;
    let vl; try { vl = v.getHeadLocation(); } catch { continue; }
    const vd = v.dimension.id;
    for (const w of who) {
      if (w.s.id === v.id || w.dim !== vd) continue;
      const dx = w.h.x - vl.x, dz = w.h.z - vl.z, d = Math.hypot(dx, dz);
      if (d > 48) continue;
      const lift = w.sneak ? -0.2 : 0;
      let at;
      if (st === 0) at = { x: w.h.x, y: w.h.y + 0.95 + lift, z: w.h.z };        // เหนือป้ายชื่อ
      else if (st === 2) at = { x: w.h.x, y: w.h.y + 0.32 + lift, z: w.h.z };   // ใต้ป้ายชื่อ
      else {                                                                      // ข้างชื่อ (ด้านซ้ายตามมุมที่เรามอง)
        const fx = d > 0.01 ? dx / d : 0, fz = d > 0.01 ? dz / d : 1, off = w.len * 0.075 + 0.3;
        at = { x: w.h.x + fz * off, y: w.h.y + 0.58 + lift, z: w.h.z - fx * off };
      }
      spawnFor(v, w.id, at, vars);
    }
  }
}

// ---------------- แจ้งเตือนข้างจอ (เห็นแค่ตัวเอง) ----------------
// ส่งเป็น title ที่ขึ้นต้นด้วย "astra:" — RP (ui/hud_screen.json) จะย้ายไปแสดงชิดขวากลางจอแทน title ปกติ
const sideShown = new Map(), sideAt = new Map(), titleHold = new Map();
// ล้างแผงข้างจอทันที: ส่ง title ว่างที่หายในทันที แล้วล้างทิ้ง
function clearSide(p) {
  try { p.onScreenDisplay.setTitle(" ", { fadeInDuration: 0, stayDuration: 1, fadeOutDuration: 0 }); p.onScreenDisplay.clearTitle(); } catch {}
  sideShown.delete(key(p.name));
}
function holdSide(p, ticks = 120) { titleHold.set(key(p.name), system.currentTick + ticks); sideShown.delete(key(p.name)); }
function updateSide() {
  const ps = world.getAllPlayers(), now = system.currentTick;
  for (const v of ps) {
    const k = key(v.name);
    if ((titleHold.get(k) ?? 0) > now) continue;
    let txt = "";
    if (S.showTalking && sideOf(k)) {
      const lines = [];
      if (talkingSet.has(k)) lines.push("§a♪ §fคุณกำลังพูด");
      const vl = v.location, vd = v.dimension.id;
      for (const s of ps) {
        const sk = key(s.name);
        if (s.id === v.id || !talkingSet.has(sk) || s.dimension.id !== vd) continue;
        const l = s.location, d = Math.hypot(l.x - vl.x, l.y - vl.y, l.z - vl.z);
        if (d <= S.range) lines.push(`§a♪ §f${s.name} §7${Math.round(d)}ม.`);
      }
      if (S.self.has(k) || S.muted.has(k)) lines.push("§c● ไมค์คุณปิดอยู่");
      if (S.selfDeaf.has(k) || S.deaf.has(k)) lines.push("§c● คุณปิดหูอยู่");
      if (lines.length) txt = "§l§dAstra Voice§r\n" + lines.slice(0, 9).join("\n");
    }
    const last = sideShown.get(k) ?? "";
    try {
      if (txt) {
        if (txt !== last || now - (sideAt.get(k) ?? 0) > 60) {
          v.onScreenDisplay.setTitle("astra:" + txt, { fadeInDuration: 0, stayDuration: 100, fadeOutDuration: 0 });
          sideShown.set(k, txt); sideAt.set(k, now);
        }
      } else if (last) clearSide(v);
    } catch { /* ignore */ }
  }
}

// ---------------- ไอเท็ม ----------------
function giveItem(p, id) {
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!inv) return;
  const left = inv.addItem(new ItemStack(id, 1));
  if (left) p.dimension.spawnItem(left, p.location);
}

// ---------------- โหมดถือไมค์ถึงพูด (สายโรล) ----------------
// เปิดได้ 2 แบบ: ผู้เล่นเปิดเอง หรือแอดมินบังคับทั้งเซิฟ — ไม่ได้ถือไอเท็มไมค์ (มือขวาหรือมือซ้าย) = ไมค์ปิด
const holdMuted = new Set();
const holdNeed = (k) => S.holdAll || S.holdSelf.has(k);
function holdsMic(p) {
  try {
    const eq = p.getComponent("minecraft:equippable");
    if (eq) {
      if (eq.getEquipment(EquipmentSlot.Offhand)?.typeId === MIC_ITEM) return true;
      if (eq.getEquipment(EquipmentSlot.Mainhand)?.typeId === MIC_ITEM) return true;
    }
  } catch {}
  try { return p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex)?.typeId === MIC_ITEM; } catch {}
  return false;
}
function hasMicItem(p) {
  if (holdsMic(p)) return true;
  try { const c = p.getComponent("minecraft:inventory")?.container; for (let i = 0; i < c.size; i++) if (c.getItem(i)?.typeId === MIC_ITEM) return true; } catch {}
  return false;
}
function updateHold() {
  for (const p of world.getAllPlayers()) {
    const k = key(p.name);
    const muted = holdNeed(k) && !holdsMic(p);
    if (muted === holdMuted.has(k)) continue;
    if (muted) holdMuted.add(k); else holdMuted.delete(k);
    mirrorPlayer(p);
    try {
      if (!S.self.has(k)) p.onScreenDisplay.setActionBar(muted ? "§7● เก็บไมค์แล้ว — ไมค์ปิด" : "§a● ถือไมค์อยู่ — พูดได้");
    } catch {}
  }
  for (const k of [...holdMuted]) if (!holdNeed(k)) holdMuted.delete(k);
}
function setHoldSelf(p, on) {
  const k = key(p.name);
  if (on) S.holdSelf.add(k); else S.holdSelf.delete(k);
  save();
  if (on && !hasMicItem(p)) giveItem(p, MIC_ITEM);
  p.sendMessage(on ? "§a[ไมค์] เปิดโหมดถือไมค์ — ถือไอเท็มไมค์ (มือขวาหรือมือซ้าย) ถึงพูดได้ §7ไอเท็มจะมองไม่เห็นตอนถือ"
    : (S.holdAll ? "§e[ไมค์] ปิดโหมดของคุณแล้ว แต่แอดมินยังบังคับโหมดถือไมค์ทั้งเซิฟอยู่" : "§a[ไมค์] ปิดโหมดถือไมค์ — พูดได้ตามปกติ"));
  updateHold();
}
function setHoldAll(p, on) {
  S.holdAll = on; save();
  if (on) for (const pl of world.getAllPlayers()) if (!hasMicItem(pl)) giveItem(pl, MIC_ITEM);
  for (const pl of world.getAllPlayers()) pl.sendMessage(on ? "§e[ไมค์] แอดมินเปิดโหมดถือไมค์ทั้งเซิฟ — ต้องถือไอเท็มไมค์ (มือขวาหรือมือซ้าย) ถึงจะพูดได้" : "§a[ไมค์] แอดมินปิดโหมดถือไมค์แล้ว — พูดได้ตามปกติ");
  updateHold();
}

function toggleSelfMic(p, fromMenu) {
  const k = key(p.name);
  const now = system.currentTick;
  if (now - (lastToggle.get(k) ?? -99) < 8) return; // กันกดเบิ้ล (มือถือ)
  lastToggle.set(k, now);
  if (!fromMenu && holdNeed(k) && !S.self.has(k)) { // โหมดถือไมค์: ถือ = พูด, เก็บ = เงียบ (ไม่ต้องกดสลับ)
    p.onScreenDisplay.setActionBar("§e● โหมดถือไมค์: ถืออยู่ = พูดได้ • เก็บเข้ากระเป๋า = ไมค์ปิด §7(ย่อ+ใช้ = เมนู)");
    return;
  }
  if (S.self.has(k)) S.self.delete(k); else S.self.add(k);
  save();
  const on = !S.self.has(k);
  p.onScreenDisplay.setActionBar(on ? "§a● ไมค์: เปิด" : "§c● ไมค์: ปิด");
  p.playSound(on ? "random.orb" : "random.click", { pitch: on ? 1.4 : 0.7 });
  if (on && S.muted.has(k)) p.sendMessage("§c[ไมค์] คุณถูกแอดมินปิดไมค์อยู่");
  if (on && !S.micEnabled && !S.mega.has(k)) p.sendMessage("§c[ไมค์] ตอนนี้แอดมินปิดไมค์ทั้งเซิฟอยู่");
  if (!linkedSet.has(k)) p.sendMessage("§e[ไมค์] คุณยังไม่ได้เชื่อมแอปไมค์ — เปิดแอปแล้วใส่ชื่อ Xbox (หรือ /astra:link รหัส)");
}

function openPlayerMenu(p) {
  const k = key(p.name);
  const near = nearbyInfo[k] ?? [];
  const f = new ActionFormData()
    .title("§lไมค์ของฉัน")
    .body(
      `ชื่อ Xbox: §b${p.name}§r\n` +
      `แอปไมค์: ${linkedSet.has(k) ? "§aเชื่อมแล้ว" : "§cยังไม่เชื่อม"}§r\n` +
      `ไมค์ของฉัน: ${onoff(!S.self.has(k))}§r\n` +
      `ระยะไมค์เซิฟ: §e${S.range} บล็อค§r\n` +
      (S.muted.has(k) ? "§cแอดมินปิดไมค์คุณอยู่\n" : "") +
      (S.deaf.has(k) ? "§cแอดมินปิดหูคุณอยู่\n" : "") +
      (!S.micEnabled ? "§cไมค์ทั้งเซิฟถูกปิด\n" : "") +
      (!S.hearEnabled ? "§cหูทั้งเซิฟถูกปิด\n" : "") +
      `§rคนที่ได้ยินคุณ: ${near.length ? near.map((n) => `§a${n.n}§7(${n.d}ม.)`).join("§f, ") : "§7ไม่มี"}\n\n` +
      "§7วิธีใช้: เปิดแอป Astra Nova Voice > ใส่ชื่อ Xbox ของคุณ > ลิงก์อัตโนมัติ"
    )
    .button(S.self.has(k) ? "§aเปิดไมค์ §8(ตอนนี้ปิดอยู่)" : "§cปิดไมค์", UI(S.self.has(k) ? "mic_off" : "mic_on"))
    .button(S.selfDeaf.has(k) ? "§aเปิดหู §8(ตอนนี้ปิดหูอยู่)" : "§cปิดหูตัวเอง", UI(S.selfDeaf.has(k) ? "ear_off" : "ear_on"))
    .button(`ระยะเสียงของฉัน: §e${S.prange.get(k) ? Math.min(S.prange.get(k), S.range) + " บล็อค" : "เต็ม (" + S.range + ")"}`, UI("range"))
    .button(`การแสดงสัญลักษณ์ไมค์: §e${STYLES[styleOf(k)]}\n§8แจ้งเตือนข้างจอ: ${sideOf(k) ? "§aเปิด" : "§cปิด"} §8(เห็นแค่คุณ)`, UI("style"));
  const acts = [() => { lastToggle.delete(k); toggleSelfMic(p, true); },
    () => toggleSelfDeaf(p), () => myRangeForm(p), () => styleForm(p)];
  f.button(`โหมดถือไมค์ถึงพูด: ${S.holdAll ? "§eแอดมินบังคับเปิด" : onoff(S.holdSelf.has(k))}\n§8ถือไอเท็มไมค์ = พูด • เก็บ = เงียบ`, UI("items"));
  acts.push(() => setHoldSelf(p, !S.holdSelf.has(k)));
  if (vfxLevel(p) && !isAdmin(p)) { f.button(`§dเปลี่ยนเสียง §8(${vfxName(S.vfx.get(k) || 0)})`, UI("vfx")); acts.push(() => vfxForm(p)); }
  if (isAdmin(p)) { f.button("§6แผงแอดมิน", UI("admin")); acts.push(() => openAdmin(p)); }
  f.button("ปิด", UI("close"));
  f.show(p).then((r) => {
    if (r.canceled || r.selection >= acts.length) return;
    acts[r.selection]();
  });
}

function toggleSelfDeaf(p) {
  const k = key(p.name);
  if (S.selfDeaf.has(k)) { S.selfDeaf.delete(k); p.sendMessage("§a[ไมค์] เปิดหูแล้ว ได้ยินคนอื่นตามปกติ"); }
  else { S.selfDeaf.add(k); p.sendMessage("§c[ไมค์] ปิดหูตัวเอง — จะไม่ได้ยินใคร §7(เปิดคืนได้ในเมนูไมค์หรือ /astra:deaf)"); }
  save(); mirrorPlayer(p);
}
function styleForm(p) {
  const k = key(p.name);
  new ModalFormData()
    .title("การแสดงผลไมค์ (เห็นแค่คุณ)")
    .dropdown((S.showTalking ? "" : "§cตอนนี้แอดมินปิดสัญลักษณ์ทั้งเซิฟอยู่\n§r") + "สัญลักษณ์ของทุกคนในเซิฟ (กำลังพูด / ปิดไมค์ / ปิดหู) จะแสดงแบบนี้บนจอของคุณ — คนอื่นไม่เห็นการตั้งค่านี้",
      STYLES, { defaultValueIndex: styleOf(k) })
    .toggle("แจ้งเตือนข้างจอ: ใครกำลังพูดใกล้ๆ คุณ", { defaultValue: sideOf(k) })
    .show(p)
    .then((r) => {
      if (r.canceled || !r.formValues) return;
      S.style.set(k, Number(r.formValues[0]) || 0);
      const wasOn = sideOf(k);
      S.side.set(k, !!r.formValues[1]);
      save();
      if (wasOn && !sideOf(k)) clearSide(p); // ปิดแล้วต้องหายทันที
      updateSide();
      p.sendMessage(`§b[ไมค์] §fสัญลักษณ์: §e${STYLES[styleOf(k)]}§f • ข้างจอ: ${onoff(sideOf(k))}`);
    });
}

// ---------------- วงระยะเสียง (เห็นคนเดียว) ----------------
const rings = new Map(); // ชื่อตัวเล็ก -> { r, until }
function showRing(p, r, seconds = 6) { if (r > 0) rings.set(key(p.name), { r, until: system.currentTick + seconds * 20 }); }
function drawRings() {
  if (!rings.size) return;
  for (const [k, ring] of rings) {
    const p = findPlayer(k);
    if (!p || system.currentTick > ring.until) { rings.delete(k); continue; }
    try {
      const v = new MolangVariableMap();
      v.setFloat("variable.radius", ring.r);
      v.setFloat("variable.count", Math.min(320, Math.max(24, Math.ceil(2 * Math.PI * ring.r * 2.5))));
      const l = p.location;
      const at = { x: l.x, y: l.y + 0.4, z: l.z }; // แท่งสูง ~0.75 ตั้งจากพื้น
      spawnFor(p, "astra:ring", at, v); // เห็นแค่ผู้เล่นคนนี้
    } catch { rings.delete(k); }
  }
}

// ---------------- ระยะพูดของตัวเอง (ตั้งในเกม) ----------------
let prVersion = 1;
function prangeNow() {
  const out = {};
  for (const p of world.getAllPlayers()) { const v = S.prange.get(key(p.name)); if (v) out[p.name] = v; }
  return out;
}
function setMyRange(p, n, quiet) {
  if (!S.personal) return p.sendMessage("§c[ไมค์] แอดมินปิดการตั้งระยะเสียงเองไว้");
  n = Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const k = key(p.name);
  if (!n || n >= S.range) S.prange.delete(k); else S.prange.set(k, n);
  prVersion++; save(); mirrorState();
  showRing(p, Math.min(S.prange.get(k) || S.range, S.range));
  if (!quiet) p.sendMessage(S.prange.has(k) ? `§b[ไมค์] §fระยะเสียงของคุณ: §e${n} บล็อค§7 (คนที่ไกลกว่านี้จะไม่ได้ยินคุณ)` : `§b[ไมค์] §fใช้ระยะเต็มของเซิฟ §e${S.range} บล็อค`);
}
// กด -/+ แล้ววงสีเขียวรอบตัวขยับตามทันที (ฟอร์มมายคราฟส่งค่าสไลเดอร์ระหว่างเลื่อนไม่ได้ จึงใช้ปุ่มแทน)
function myRangeForm(p) {
  if (!S.personal) return p.sendMessage("§c[ไมค์] แอดมินปิดการตั้งระยะเสียงเองไว้");
  const k = key(p.name), max = Math.max(1, S.range);
  const cur = Math.min(S.prange.get(k) || max, max);
  showRing(p, cur, 3600); // ค้างวงไว้ตลอดที่เปิดเมนูนี้
  const bar = "§a" + "█".repeat(Math.round((cur / max) * 20)) + "§8" + "█".repeat(20 - Math.round((cur / max) * 20));
  const steps = [-10, -5, -1, 1, 5, 10];
  const f = new ActionFormData()
    .title("ระยะเสียงของฉัน")
    .body(`§fระยะตอนนี้: §a§l${cur} บล็อค§r §7/ สูงสุด ${max}\n${bar}\n\n§7วงสีเขียวรอบตัวคือระยะที่คนอื่นได้ยินคุณ (เห็นแค่คุณ)`);
  for (const d of steps) f.button(`${d > 0 ? "§a+" : "§c"}${d} บล็อค`, UI("range"));
  f.button("§eระยะเต็มของเซิฟ", UI("range"));
  f.button("§bพิมพ์ตัวเลขเอง", UI("style"));
  f.button("§aเสร็จ", UI("close"));
  f.show(p).then((r) => {
    if (r.canceled || r.selection === steps.length + 3) { showRing(p, Math.min(S.prange.get(k) || S.range, S.range), 4); return; }
    if (r.selection < steps.length) setMyRange(p, Math.max(1, Math.min(max, cur + steps[r.selection])), true);
    else if (r.selection === steps.length) setMyRange(p, 0, true);
    else return new ModalFormData().title("ระยะเสียงของฉัน")
      .textField(`ใส่ตัวเลข 1 - ${max}`, String(cur), { defaultValue: String(cur) }).show(p)
      .then((m) => { if (!m.canceled && m.formValues) setMyRange(p, Math.max(1, Math.min(max, Number(m.formValues[0]) || cur)), true); myRangeForm(p); });
    myRangeForm(p);
  });
}

// ---------------- แผงแอดมิน ----------------
function openAdmin(p) {
  if (!isAdmin(p)) return p.sendMessage("§c[ไมค์] เฉพาะแอดมินเท่านั้น");
  new ActionFormData()
    .title("§l§dAstra Nova §6แผงควบคุมไมค์")
    .body(`สถานะ voice server: ${online ? "§aออนไลน์" : "§cออฟไลน์"}§r\nคนเชื่อมแอป: §b${linkedSet.size}§r / ${world.getAllPlayers().length}`)
    .button(`ระยะไมค์: §e${S.range} บล็อค`, UI("range"))
    .button(`ไมค์ทั้งเซิฟ: ${onoff(S.micEnabled)}`, UI(S.micEnabled ? "mic_all" : "mic_off"))
    .button(`หูทั้งเซิฟ: ${onoff(S.hearEnabled)}`, UI(S.hearEnabled ? "ear_all" : "ear_off"))
    .button("จัดการผู้เล่นรายคน", UI("players"))
    .button("§dประกาศ", UI("announce"))
    .button(`สัญลักษณ์คนพูด: ${onoff(S.showTalking)}\n§8แบบเริ่มต้น: ${STYLES[S.defStyle]}`, UI("style"))
    .button("รับไอเท็มไมค์ / แจกทุกคน", UI("items"))
    .button(`§dเปลี่ยนเสียง §8(ของคุณ: ${vfxName(S.vfx.get(key(p.name)) || 0)})`, UI("vfx"))
    .button(`§9กำแพงกั้นเสียง & เอฟเฟกต์\n§8ผนัง: ${S.occEnabled ? "§aเปิด" : "§cปิด"} §8• ใต้น้ำ: ${S.waterEnabled ? "§aเปิด" : "§cปิด"}`, UI("walls"))
    .button(`โหมดถือไมค์ถึงพูด (ทั้งเซิฟ): ${onoff(S.holdAll)}\n§8ต้องถือไอเท็มไมค์ถึงจะพูดได้`, UI("items"))
    .show(p)
    .then((r) => {
      if (r.canceled) return;
      switch (r.selection) {
        case 0: return rangeForm(p);
        case 1: S.micEnabled = !S.micEnabled; save();
          world.sendMessage(`§6[ไมค์] §fแอดมินได้${S.micEnabled ? "§aเปิด" : "§cปิด"}ไมค์ทั้งเซิฟ`); return openAdmin(p);
        case 2: S.hearEnabled = !S.hearEnabled; save();
          world.sendMessage(`§6[ไมค์] §fแอดมินได้${S.hearEnabled ? "§aเปิด" : "§cปิด"}หูทั้งเซิฟ`); return openAdmin(p);
        case 3: return playerList(p);
        case 4: return announceForm(p);
        case 5: return talkIconMenu(p);
        case 6: return giveMenu(p);
        case 7: return vfxForm(p);
        case 8: return fxForm(p);
        case 9: return setHoldAll(p, !S.holdAll);
      }
    });
}

const FALLOFF = ["ค่อยๆ เบาลง (ธรรมชาติ)", "เบาลงแบบเส้นตรง", "ดังเท่ากันทั้งระยะ"];
function fxForm(p) {
  new ModalFormData()
    .title("กำแพงกั้นเสียง & เอฟเฟกต์")
    .toggle("§lเปิดระบบกำแพงกั้นเสียง§r\n§7เสียงจะอู้เมื่อมีบล็อคทึบขวางระหว่างคนพูดกับคนฟัง", { defaultValue: S.occEnabled })
    .slider("ผนังกี่บล็อค = §eเสียงอู้เล็กน้อย§r (เบาลง 30%)", 1, 10, { valueStep: 1, defaultValue: S.occThin })
    .slider("ผนังกี่บล็อค = §6เสียงอู้มาก§r (เบาลง 55%)", 1, 15, { valueStep: 1, defaultValue: S.occThick })
    .slider("ผนังกี่บล็อค = §cไม่ได้ยินเลย§r (0 = ไม่ตัดเสียง)", 0, 20, { valueStep: 1, defaultValue: S.occBlock })
    .toggle("ใต้น้ำเสียงอู้", { defaultValue: S.waterEnabled })
    .toggle("เสียงสเตอริโอ ซ้าย/ขวาตามทิศที่หัน", { defaultValue: S.stereo })
    .toggle("ให้ผู้เล่นปรับระยะพูดของตัวเองในแอปได้", { defaultValue: S.personal })
    .dropdown("ความดังตามระยะ", FALLOFF, { defaultValueIndex: S.falloff })
    .show(p)
    .then((r) => {
      if (r.canceled || !r.formValues) return openAdmin(p);
      const v = r.formValues;
      S.occEnabled = !!v[0];
      S.occThin = Math.round(v[1]);
      S.occThick = Math.max(S.occThin, Math.round(v[2]));
      S.occBlock = Math.round(v[3]) && Math.max(S.occThick, Math.round(v[3]));
      S.waterEnabled = !!v[4]; S.stereo = !!v[5]; S.personal = !!v[6]; S.falloff = Number(v[7]) || 0;
      save();
      p.sendMessage(`§6[ไมค์] §fบันทึกแล้ว: ผนัง ${onoff(S.occEnabled)}§f (อู้ ${S.occThin} / อู้มาก ${S.occThick} / ตัด ${S.occBlock || "ไม่ตัด"} บล็อค) • ใต้น้ำ ${onoff(S.waterEnabled)}§f • สเตอริโอ ${onoff(S.stereo)}§f • ระยะส่วนตัว ${onoff(S.personal)}`);
      openAdmin(p);
    });
}

function talkIconMenu(p) {
  new ModalFormData()
    .title("สัญลักษณ์คนที่กำลังพูด")
    .toggle("เปิดสัญลักษณ์คนพูด (ทั้งเซิฟ)", { defaultValue: S.showTalking })
    .dropdown("แบบเริ่มต้น (ผู้เล่นเปลี่ยนเองได้ในเมนูไมค์)", STYLES, { defaultValueIndex: S.defStyle })
    .submitButton("บันทึก")
    .show(p)
    .then((r) => {
      if (r.canceled || !r.formValues) return openAdmin(p);
      S.showTalking = !!r.formValues[0]; S.defStyle = Number(r.formValues[1]) || 0;
      save(); updateNameTags(); openAdmin(p);
    });
}

function rangeForm(p) {
  new ModalFormData()
    .title("ตั้งระยะไมค์")
    .slider(`ระยะที่ได้ยินเสียง (บล็อค)\n§7ใกล้ = ดังเต็ม, ไกล = ค่อยๆ เบาลง, 0 = ไม่มีใครได้ยิน`, 0, CONFIG.maxRange, { valueStep: 1, defaultValue: S.range })
    .submitButton("บันทึก")
    .show(p)
    .then((r) => {
      if (r.canceled) return openAdmin(p);
      S.range = clampRange(r.formValues[0]);
      showRing(p, S.range);
      save();
      world.sendMessage(`§6[ไมค์] §fระยะไมค์ถูกตั้งเป็น §e${S.range} บล็อค`);
      openAdmin(p);
    });
}

function playerList(p) {
  const list = world.getAllPlayers();
  const f = new ActionFormData().title("จัดการผู้เล่น").body("§a●§7 = เชื่อมแอปแล้ว  §8●§7 = ยังไม่เชื่อม");
  for (const t of list) {
    const k = key(t.name);
    f.button(
      `${t.name} ${linkedSet.has(k) ? "§a●" : "§8●"}\n` +
      `${S.muted.has(k) ? "§cไมค์ปิด" : "§aไมค์เปิด"} §8| ${S.deaf.has(k) ? "§cหูปิด" : "§aหูเปิด"}${S.mega.has(k) ? " §8| §dโทรโข่ง" : ""}`,
      UI(S.deaf.has(k) ? "ear_off" : S.muted.has(k) ? "mic_off" : "mic_on")
    );
  }
  f.button("« กลับ", UI("back"));
  f.show(p).then((r) => {
    if (r.canceled) return;
    if (r.selection === list.length) return openAdmin(p);
    const t = list[r.selection];
    if (t) playerForm(p, t.name);
  });
}

function playerForm(p, name) {
  const k = key(name);
  new ModalFormData()
    .title(name)
    .toggle("ปิดไมค์คนนี้", { defaultValue: S.muted.has(k) })
    .toggle("ปิดหูคนนี้", { defaultValue: S.deaf.has(k) })
    .toggle("โทรโข่ง (พูดแล้วได้ยินทั้งเซิฟเต็มเสียง แม้ปิดไมค์ทั้งเซิฟ)", { defaultValue: S.mega.has(k) })
    .submitButton("บันทึก")
    .show(p)
    .then((r) => {
      if (r.canceled) return playerList(p);
      const [m, d, g] = r.formValues;
      m ? S.muted.add(k) : S.muted.delete(k);
      d ? S.deaf.add(k) : S.deaf.delete(k);
      g ? S.mega.add(k) : S.mega.delete(k);
      save();
      const t = findPlayer(name);
      t?.sendMessage(`§6[ไมค์] §fแอดมินตั้งค่าให้คุณ: ไมค์ ${onoff(!m)}§f, หู ${onoff(!d)}§f${g ? ", §dโทรโข่ง" : ""}`);
      playerList(p);
    });
}

function announceForm(p) {
  new ModalFormData()
    .title("ประกาศ")
    .textField("ข้อความประกาศ", "เช่น อีก 5 นาทีเริ่มกิจกรรม")
    .toggle("แสดงกลางจอ (title)", { defaultValue: true })
    .toggle("ส่งไปที่แอปไมค์ด้วย", { defaultValue: true })
    .submitButton("ประกาศ")
    .show(p)
    .then((r) => {
      if (r.canceled) return openAdmin(p);
      const [msg, title, toApp] = r.formValues;
      if (!String(msg).trim()) return announceForm(p);
      announce(String(msg), title, toApp, p.name);
    });
}

function announce(msg, title = true, toApp = true, by = "แอดมิน") {
  world.sendMessage(`§6§l[ประกาศ]§r §f${msg}`);
  for (const pl of world.getAllPlayers()) {
    pl.playSound("note.pling", { pitch: 1.2 });
    if (title) holdSide(pl, 110);
    if (title) pl.onScreenDisplay.setTitle("§6ประกาศ", { subtitle: "§f" + msg, fadeInDuration: 5, stayDuration: 80, fadeOutDuration: 10 });
  }
  if (toApp) announceQueue.push({ text: msg, by });
}

function giveMenu(p) {
  new ActionFormData()
    .title("ไอเท็มไมค์")
    .button("รับไอเท็มไมค์", UI("mic_on"))
    .button("รับแผงแอดมิน", UI("admin"))
    .button("แจกไอเท็มไมค์ให้ทุกคน", UI("items"))
    .show(p)
    .then((r) => {
      if (r.canceled) return;
      if (r.selection === 0) giveItem(p, MIC_ITEM);
      if (r.selection === 1) giveItem(p, ADMIN_ITEM);
      if (r.selection === 2) for (const t of world.getAllPlayers()) giveItem(t, MIC_ITEM);
    });
}

// ---------------- events ----------------
world.afterEvents.itemUse.subscribe((ev) => {
  const p = ev.source, id = ev.itemStack?.typeId;
  if (id === MIC_ITEM) {
    if (p.isSneaking) system.run(() => openPlayerMenu(p));
    else toggleSelfMic(p);
  } else if (id === ADMIN_ITEM) {
    system.run(() => openAdmin(p));
  }
});

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  const p = ev.player;
  mirrorPlayer(p);
  if (S.prange.has(key(p.name))) { prVersion++; system.runTimeout(mirrorState, 20); }
  system.runTimeout(() => {
    try {
      if (CONFIG.giveMicOnFirstJoin && !p.getDynamicProperty("mcvoice:gotMic")) {
        giveItem(p, MIC_ITEM);
        p.setDynamicProperty("mcvoice:gotMic", true);
      }
      if (!linkedSet.has(key(p.name))) p.sendMessage("§b[ไมค์] §fเซิฟนี้มีไมค์ตามระยะ! เปิดแอป " + APP + "§f ใส่ชื่อ Xbox §e" + p.name.replace(/§./g, "").replace(/\[[^\]]*\]/g, "").trim() + "§f แล้วพูดได้เลย\n§7(หรือใช้รหัสจากแอป: §f/astra:link รหัส§7)\n§7ถือไอเท็มไมค์แล้วกด = เปิด/ปิดไมค์ • ย่อตัว+กด = เมนู • /astra:voice = เมนู");
    } catch { /* ผู้เล่นออกไปแล้ว */ }
  }, 60);
});

// ---------------- ลิงก์แอปด้วยรหัส ----------------
function clearClaim(k) {
  const c = claims.get(k);
  if (!c) return;
  claims.delete(k);
  const p = findPlayer(c.n);
  try { p?.removeTag("astra_lc_" + c.code); } catch {}
}
function claimLink(p, raw) {
  const code = String(raw ?? "").replace(/\D/g, "");
  if (code.length !== 6) { p.sendMessage("§c[ไมค์] รหัสต้องเป็นตัวเลข 6 หลัก (ดูในแอป " + APP + "§c)"); return; }
  clearClaim(key(p.name));
  claims.set(key(p.name), { n: p.name, code, until: system.currentTick + 20 * 120 });
  try { p.addTag("astra_lc_" + code); } catch {}
  p.sendMessage("§e[ไมค์] กำลังเชื่อมกับแอป…");
}
system.runInterval(() => {
  for (const [k, c] of claims) if (system.currentTick > c.until) {
    clearClaim(k);
    findPlayer(c.n)?.sendMessage("§c[ไมค์] เชื่อมไม่สำเร็จ: รหัสไม่ถูกหรือหมดอายุ ลองกดรหัสใหม่ในแอป");
  }
}, 20);

system.beforeEvents.startup.subscribe((ev) => {
  const reg = ev.customCommandRegistry;
  reg.registerCommand({
    name: "astra:link", description: "เชื่อมแอปไมค์ Astra Nova Voice ด้วยรหัส 6 หลักจากแอป",
    permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false,
    mandatoryParameters: [{ name: "code", type: CustomCommandParamType.String }],
  }, (origin, code) => {
    const p = origin.sourceEntity;
    if (p?.typeId !== "minecraft:player") return { status: CustomCommandStatus.Failure, message: "ใช้ได้เฉพาะผู้เล่น" };
    system.run(() => claimLink(p, code));
    return { status: CustomCommandStatus.Success };
  });
  reg.registerCommand({
    name: "astra:range", description: "ตั้งระยะเสียงของตัวเอง (บล็อค) — 0 = ใช้ระยะเต็มของเซิฟ",
    permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false,
    optionalParameters: [{ name: "blocks", type: CustomCommandParamType.Integer }],
  }, (origin, blocks) => {
    const p = origin.sourceEntity;
    if (p?.typeId === "minecraft:player") system.run(() => (blocks === undefined ? myRangeForm(p) : setMyRange(p, blocks)));
    return { status: CustomCommandStatus.Success };
  });
  reg.registerCommand({
    name: "astra:deaf", description: "ปิด/เปิดหูตัวเอง (ไม่ได้ยินใคร)",
    permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false,
  }, (origin) => {
    const p = origin.sourceEntity;
    if (p?.typeId === "minecraft:player") system.run(() => toggleSelfDeaf(p));
    return { status: CustomCommandStatus.Success };
  });
  reg.registerCommand({
    name: "astra:vfx", description: "เปลี่ยนเสียง (แท็ก mic = เสียงพื้นฐาน, แท็ก ad / OP = ทุกเสียง)",
    permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false,
  }, (origin) => {
    const p = origin.sourceEntity;
    if (p?.typeId === "minecraft:player") system.run(() => vfxForm(p));
    return { status: CustomCommandStatus.Success };
  });
  reg.registerCommand({
    name: "astra:voice", description: "เปิดเมนูไมค์ Astra Nova Voice",
    permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false,
  }, (origin) => {
    const p = origin.sourceEntity;
    if (p?.typeId === "minecraft:player") system.run(() => (isAdmin(p) ? openAdmin(p) : openPlayerMenu(p)));
    return { status: CustomCommandStatus.Success };
  });
});

// คำสั่งสำหรับคอนโซล/command block:
// /scriptevent voice:range 30 | voice:mic on|off | voice:hear on|off | voice:announce ข้อความ
// /scriptevent voice:mute ชื่อ | voice:unmute ชื่อ | voice:deaf ชื่อ | voice:undeaf ชื่อ | voice:give
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const msg = (ev.message ?? "").trim();
  const src = ev.sourceEntity;
  const bool = (s) => /^(on|true|1|เปิด)$/i.test(s);
  switch (ev.id) {
    case "voice:range": S.range = clampRange(msg); save(); world.sendMessage(`§6[ไมค์] §fระยะไมค์: §e${S.range} บล็อค`); break;
    case "voice:mic": S.micEnabled = bool(msg); save(); world.sendMessage(`§6[ไมค์] §fไมค์ทั้งเซิฟ: ${onoff(S.micEnabled)}`); break;
    case "voice:hear": S.hearEnabled = bool(msg); save(); world.sendMessage(`§6[ไมค์] §fหูทั้งเซิฟ: ${onoff(S.hearEnabled)}`); break;
    case "voice:announce": if (msg) announce(msg); break;
    case "voice:mute": S.muted.add(key(msg)); save(); break;
    case "voice:unmute": S.muted.delete(key(msg)); save(); break;
    case "voice:deaf": S.deaf.add(key(msg)); save(); break;
    case "voice:undeaf": S.deaf.delete(key(msg)); save(); break;
    case "voice:give": if (src?.typeId === "minecraft:player") giveItem(src, MIC_ITEM); break;
    case "astra:link": if (src?.typeId === "minecraft:player") claimLink(src, msg); break;
    case "voice:admin": if (src?.typeId === "minecraft:player") giveItem(src, ADMIN_ITEM); break;
  }
});

export function startCore(t) {
  transport = t;
  world.afterEvents.worldLoad.subscribe(() => {
    load();
    mirrorState();
    transport.start(core);
    system.runInterval(drawIndicators, 3);
    system.runInterval(updateHold, 2);
    system.runInterval(updateSide, 10);
    system.runInterval(updateEnv, 5);
    system.runInterval(drawRings, 3);
    console.warn(`[MCVoice] เริ่มทำงาน (${transport.mode}) ระยะ ${S.range}`);
  });
}
