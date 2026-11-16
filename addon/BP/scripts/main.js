import { world, system, ItemStack, MolangVariableMap } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";

const MIC_ITEM = "voice:mic_toggle";
const ADMIN_ITEM = "voice:admin_panel";
const DP_KEY = "mcvoice:state";
const APP = "§dAstra Nova Voice§r";
const TALK_SUFFIX = "\n§a((♪))";

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
  muted: new Set(), // แอดมินปิดไมค์รายคน (ชื่อตัวเล็ก)
  deaf: new Set(), // แอดมินปิดหูรายคน
  mega: new Set(), // โทรโข่ง: พูดแล้วได้ยินทั้งเซิฟ
  self: new Set(), // ผู้เล่นปิดไมค์ตัวเองด้วยไอเท็ม
};
let announceQueue = [];
let busy = false;
let online = false;
let lastOkTick = 0;
let linkedSet = new Set();
let talkingSet = new Set();
let nearbyInfo = {};
const lastToggle = new Map();
const origNameTag = new Map();

const key = (name) => name.toLowerCase();

function save() {
  mirrorState();
  try {
    world.setDynamicProperty(
      DP_KEY,
      JSON.stringify({
        range: S.range, micEnabled: S.micEnabled, hearEnabled: S.hearEnabled, showTalking: S.showTalking, showTalkTag: S.showTalkTag,
        muted: [...S.muted], deaf: [...S.deaf], mega: [...S.mega], self: [...S.self],
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
    for (const k of ["muted", "deaf", "mega", "self"]) if (Array.isArray(o[k])) S[k] = new Set(o[k]);
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
    settings: { range: S.range, micEnabled: S.micEnabled, hearEnabled: S.hearEnabled },
    muted: [...S.muted], deaf: [...S.deaf], mega: [...S.mega], self: [...S.self],
    players,
    occ: env.occ,
    announce: announceQueue,
  };
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
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    const k = Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z);
    if (k === last) continue;
    last = k;
    if (solidAt(dim, x, y, z) && ++count >= 3) break;
  }
  return count >= 3 ? 2 : count >= 1 ? 1 : 0;
}
function updateEnv() {
  const ps = world.getAllPlayers();
  const water = new Set(), heads = [];
  for (const p of ps) {
    try {
      const h = p.getHeadLocation();
      const b = p.dimension.getBlock({ x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) });
      if (b && b.typeId.includes("water")) water.add(key(p.name));
      heads.push({ k: key(p.name), d: p.dimension, h });
    } catch { /* ignore */ }
  }
  const occ = {}, R = Math.min(S.range, 48);
  for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) {
    const a = heads[i], b = heads[j];
    if (a.d.id !== b.d.id || Math.hypot(a.h.x - b.h.x, a.h.y - b.h.y, a.h.z - b.h.z) > R) continue;
    const lvl = countWalls(a.d, a.h, b.h);
    if (lvl) occ[[a.k, b.k].sort().join("|")] = lvl;
  }
  env.water = water; env.occ = occ;
  if (transport.mode === "world") {
    for (const p of ps) { try { if (water.has(key(p.name))) p.addTag("astra_water"); else p.removeTag("astra_water"); } catch {} }
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
  } catch (e) { console.warn("[MCVoice] scoreboard " + e); }
  for (const p of world.getAllPlayers()) mirrorPlayer(p);
}
function mirrorPlayer(p) {
  if (transport.mode !== "world") return;
  const k = key(p.name);
  for (const [set, tag] of [[S.muted, "astra_muted"], [S.deaf, "astra_deaf"], [S.mega, "astra_mega"], [S.self, "astra_self"]]) {
    try { if (set.has(k)) p.addTag(tag); else p.removeTag(tag); } catch { /* ignore */ }
  }
}

function handleResponse(r) {
  // ส่งรหัสยืนยันให้ผู้เล่น (เห็นคนเดียว)
  for (const l of r.links ?? []) {
    const p = findPlayer(l.n);
    if (!p) continue;
    p.sendMessage(`§e[ไมค์] §fมีคำขอเชื่อมแอปไมค์กับชื่อ §b${p.name}\n§fรหัสยืนยันของคุณ: §a§l${l.code}§r\n§7พิมพ์รหัสนี้ในแอป (อย่าบอกใคร) ถ้าไม่ได้ขอเอง ให้เพิกเฉย`);
    p.onScreenDisplay.setTitle(`§a${l.code}`, { subtitle: "§fรหัสยืนยันแอปไมค์", fadeInDuration: 5, stayDuration: 100, fadeOutDuration: 10 });
  }
  for (const n of r.justLinked ?? []) {
    const p = findPlayer(n);
    if (p) { p.sendMessage("§a[ไมค์] เชื่อมแอปสำเร็จ! คุยกับคนรอบตัวได้แล้ว"); p.playSound("random.levelup"); }
  }
  linkedSet = new Set((r.linked ?? []).map(key));
  talkingSet = new Set((r.talking ?? []).map(key));
  nearbyInfo = r.nearby ?? {};
  updateNameTags();
}

function updateNameTags() {
  for (const p of world.getAllPlayers()) {
    const k = key(p.name);
    const shouldShow = S.showTalkTag && talkingSet.has(k);
    const cur = p.nameTag;
    const hasSuffix = cur.endsWith(TALK_SUFFIX);
    if (shouldShow && !hasSuffix) {
      origNameTag.set(k, cur);
      p.nameTag = cur + TALK_SUFFIX;
    } else if (!shouldShow && hasSuffix) {
      p.nameTag = origNameTag.get(k) ?? cur.slice(0, -TALK_SUFFIX.length);
      origNameTag.delete(k);
    }
  }
}

// ---------------- ไอคอนกำลังพูดบนหัว ----------------
let talkFrame = 0;
function drawTalkingIcons() {
  if (!S.showTalking || talkingSet.size === 0) return;
  talkFrame = (talkFrame + 0.5) % 4;
  const vars = new MolangVariableMap();
  vars.setFloat("variable.frame", talkFrame);
  for (const p of world.getAllPlayers()) {
    if (!talkingSet.has(key(p.name))) continue;
    try {
      const h = p.getHeadLocation();
      const y = p.isSneaking ? 0.75 : 0.95; // อยู่เหนือป้ายชื่อ
      p.dimension.spawnParticle("astra:talking", { x: h.x, y: h.y + y, z: h.z }, vars);
    } catch { /* chunk ยังไม่โหลด */ }
  }
}

// ---------------- ไอเท็ม ----------------
function giveItem(p, id) {
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!inv) return;
  const left = inv.addItem(new ItemStack(id, 1));
  if (left) p.dimension.spawnItem(left, p.location);
}

function toggleSelfMic(p) {
  const k = key(p.name);
  const now = system.currentTick;
  if (now - (lastToggle.get(k) ?? -99) < 8) return; // กันกดเบิ้ล (มือถือ)
  lastToggle.set(k, now);
  if (S.self.has(k)) S.self.delete(k); else S.self.add(k);
  save();
  const on = !S.self.has(k);
  p.onScreenDisplay.setActionBar(on ? "§a● ไมค์: เปิด" : "§c● ไมค์: ปิด");
  p.playSound(on ? "random.orb" : "random.click", { pitch: on ? 1.4 : 0.7 });
  if (on && S.muted.has(k)) p.sendMessage("§c[ไมค์] คุณถูกแอดมินปิดไมค์อยู่");
  if (on && !S.micEnabled && !S.mega.has(k)) p.sendMessage("§c[ไมค์] ตอนนี้แอดมินปิดไมค์ทั้งเซิฟอยู่");
  if (!linkedSet.has(k)) p.sendMessage("§e[ไมค์] คุณยังไม่ได้เปิดแอปไมค์ / ยังไม่ได้ยืนยันชื่อ");
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
    .button(S.self.has(k) ? "§aเปิดไมค์" : "§cปิดไมค์", "textures/items/redstone_dust");
  if (isAdmin(p)) f.button("§6แผงแอดมิน", "textures/items/gold_ingot");
  f.button("ปิด");
  f.show(p).then((r) => {
    if (r.canceled) return;
    if (r.selection === 0) { lastToggle.delete(k); toggleSelfMic(p); }
    else if (r.selection === 1 && isAdmin(p)) openAdmin(p);
  });
}

// ---------------- แผงแอดมิน ----------------
function openAdmin(p) {
  if (!isAdmin(p)) return p.sendMessage("§c[ไมค์] เฉพาะแอดมินเท่านั้น");
  new ActionFormData()
    .title("§l§dAstra Nova §6แผงควบคุมไมค์")
    .body(`สถานะ voice server: ${online ? "§aออนไลน์" : "§cออฟไลน์"}§r\nคนเชื่อมแอป: §b${linkedSet.size}§r / ${world.getAllPlayers().length}`)
    .button(`ระยะไมค์: §e${S.range} บล็อค`, "textures/items/compass_item")
    .button(`ไมค์ทั้งเซิฟ: ${onoff(S.micEnabled)}`, "textures/items/redstone_dust")
    .button(`หูทั้งเซิฟ: ${onoff(S.hearEnabled)}`, "textures/items/record_cat")
    .button("จัดการผู้เล่นรายคน", "textures/items/name_tag")
    .button("§dประกาศ", "textures/items/book_writable")
    .button(`ไอคอนไมค์บนหัวคนพูด: ${onoff(S.showTalking)}\n§8ป้ายชื่อ ((♪)): ${onoff(S.showTalkTag)}`, "textures/items/sign")
    .button("รับไอเท็มไมค์ / แจกทุกคน", "textures/items/iron_ingot")
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
      }
    });
}

function talkIconMenu(p) {
  new ModalFormData()
    .title("แสดงคนที่กำลังพูด")
    .toggle("ไอคอนไมค์ลอยบนหัว (ทุกคนเห็น)", { defaultValue: S.showTalking })
    .toggle("ต่อท้ายป้ายชื่อด้วย ((♪))", { defaultValue: S.showTalkTag })
    .submitButton("บันทึก")
    .show(p)
    .then((r) => {
      if (r.canceled) return openAdmin(p);
      [S.showTalking, S.showTalkTag] = r.formValues;
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
      `${S.muted.has(k) ? "§cไมค์ปิด" : "§aไมค์เปิด"} §8| ${S.deaf.has(k) ? "§cหูปิด" : "§aหูเปิด"}${S.mega.has(k) ? " §8| §dโทรโข่ง" : ""}`
    );
  }
  f.button("« กลับ");
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
    if (title) pl.onScreenDisplay.setTitle("§6ประกาศ", { subtitle: "§f" + msg, fadeInDuration: 5, stayDuration: 80, fadeOutDuration: 10 });
  }
  if (toApp) announceQueue.push({ text: msg, by });
}

function giveMenu(p) {
  new ActionFormData()
    .title("ไอเท็มไมค์")
    .button("รับไอเท็มไมค์")
    .button("รับแผงแอดมิน")
    .button("แจกไอเท็มไมค์ให้ทุกคน")
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
  system.runTimeout(() => {
    try {
      if (CONFIG.giveMicOnFirstJoin && !p.getDynamicProperty("mcvoice:gotMic")) {
        giveItem(p, MIC_ITEM);
        p.setDynamicProperty("mcvoice:gotMic", true);
      }
      p.sendMessage("§b[ไมค์] §fเซิฟนี้มีไมค์ตามระยะ! เปิดแอป " + APP + "§f แล้วใส่ชื่อ §e" + p.name + "§f ก็ใช้ได้เลย\n§7ถือไอเท็มไมค์แล้วกด = เปิด/ปิดไมค์ • ย่อตัว+กด = เมนู");
    } catch { /* ผู้เล่นออกไปแล้ว */ }
  }, 60);
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
    case "voice:admin": if (src?.typeId === "minecraft:player") giveItem(src, ADMIN_ITEM); break;
  }
});

export function startCore(t) {
  transport = t;
  world.afterEvents.worldLoad.subscribe(() => {
    load();
    mirrorState();
    transport.start(core);
    system.runInterval(drawTalkingIcons, 2);
    system.runInterval(updateEnv, 10);
    console.warn(`[MCVoice] เริ่มทำงาน (${transport.mode}) ระยะ ${S.range}`);
  });
}
