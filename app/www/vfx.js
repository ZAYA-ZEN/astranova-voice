// ตัวเปลี่ยนเสียง (แอดมิน) + ตัดเสียงรบกวนแบบแรง
// ทำงานกับเสียง PCM16 16kHz ทีละเฟรม ก่อนบีบอัดส่งออก
// ต้องตรงกับ VoiceFx.java (Android) และ AstraVoiceFx ใน VoiceEnginePlugin.swift (iOS)
(function () {
  const RATE = 16000;
  const NAMES = ["ปกติ", "ยักษ์ (เสียงต่ำ)", "ชิปมังก์ (เสียงสูง)", "หุ่นยนต์", "ปีศาจ", "วิทยุสื่อสาร", "ก้องในถ้ำ", "เด็ก",
    "โทรศัพท์", "เอเลี่ยน", "ผี", "ซอมบี้", "โทรโข่ง"];
  const PITCH = [1, 0.7, 1.6, 1, 0.58, 1, 1, 1.3, 1, 1.25, 1.15, 0.75, 1];
  const co = (f) => Math.exp(-2 * Math.PI * f / RATE);
  const BAND = { 5: [co(400), co(2800)], 8: [co(500), co(2500)], 12: [co(600), co(3500)] };

  function VoiceFx() {
    const N = 4096, W = 1200;
    const buf = new Float32Array(N);
    let w = 0, ph = 0, t = 0;
    const EL = 3200;
    const eb = new Float32Array(EL);
    let ew = 0, hpY = 0, hpX = 0, lp = 0;
    // ตัดเสียงรบกวนแบบแรง
    let dnY = 0, dnX = 0, dnG = 1;
    const DN_HP = co(120);

    function tap(p) {
      let pos = w - (p * W + 1);
      while (pos < 0) pos += N;
      const i = Math.floor(pos), f = pos - i;
      const a = buf[i % N], b = buf[(i + 1) % N];
      return a + (b - a) * f;
    }
    function pitch(x, r) {
      buf[w] = x;
      ph += (1 - r) / W;
      ph -= Math.floor(ph);
      const p2 = (ph + 0.5) % 1;
      const s1 = Math.sin(Math.PI * ph), s2 = Math.sin(Math.PI * p2);
      const y = tap(ph) * s1 * s1 + tap(p2) * s2 * s2;
      w = (w + 1) % N;
      return y;
    }
    function band(x, ha, la) {
      hpY = ha * (hpY + x - hpX); hpX = x;
      lp = lp + (1 - la) * (hpY - lp);
      return lp;
    }
    function echo(x, fb) { const d = eb[ew]; const y = x + 0.5 * d; eb[ew] = x + fb * d; ew = (ew + 1) % EL; return y; }
    return {
      // ตัดเสียงรบกวนแบบแรง: ตัดเสียงหึ่งต่ำกว่า 120Hz + กดเสียงเบาๆ ระหว่างคำพูด
      denoise(pcm) {
        let sq = 0;
        for (let i = 0; i < pcm.length; i++) {
          const x = pcm[i] / 32768;
          dnY = DN_HP * (dnY + x - dnX); dnX = x;
          sq += dnY * dnY;
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(dnY * 32767)));
        }
        const rms = Math.sqrt(sq / pcm.length), T = 0.02;
        const target = rms >= T ? 1 : Math.pow(rms / T, 2);
        const step = (target - dnG) / pcm.length;
        for (let i = 0; i < pcm.length; i++) { dnG += step; pcm[i] = Math.round(pcm[i] * dnG); }
        return pcm;
      },
      process(pcm, id) {
        if (!id || id >= PITCH.length) return pcm;
        const r = PITCH[id];
        for (let i = 0; i < pcm.length; i++) {
          let x = pcm[i] / 32768;
          if (r !== 1) x = pitch(x, r);
          switch (id) {
            case 3: x = x * Math.sin(2 * Math.PI * 55 * t / RATE) * 1.6; break;           // หุ่นยนต์
            case 4: x = Math.tanh(x * 1.8) * 0.8; break;                                    // ปีศาจ
            case 5: x = Math.tanh(band(x, BAND[5][0], BAND[5][1]) * 4) * 0.6; break;        // วิทยุ
            case 6: x = echo(x, 0.4) * 0.8; break;                                          // ก้อง
            case 8: x = band(x, BAND[8][0], BAND[8][1]) * 1.4; break;                       // โทรศัพท์
            case 9: x = x * (0.55 + 0.45 * Math.sin(2 * Math.PI * 30 * t / RATE)) * 1.2; break; // เอเลี่ยน
            case 10: x = echo(x, 0.55) * 0.7 * (0.85 + 0.15 * Math.sin(2 * Math.PI * 5 * t / RATE)); break; // ผี
            case 11: x = Math.tanh(x * 3) * 0.6; break;                                     // ซอมบี้
            case 12: x = Math.tanh(band(x, BAND[12][0], BAND[12][1]) * 5) * 0.5; break;     // โทรโข่ง
          }
          t = (t + 1) % RATE;
          const v = Math.round(x * 32767);
          pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
        return pcm;
      },
    };
  }
  window.AstraVfx = { NAMES, create: VoiceFx };
})();
