// ตัวเปลี่ยนเสียง (ใช้เฉพาะแอดมิน — แอดมินเลือกในเกม แล้วระบบเสียงบอกแอปว่าใช้เสียงแบบไหน)
// ทำงานกับเสียง PCM16 16kHz ทีละเฟรม ก่อนบีบอัดส่งออก
// ต้องตรงกับ VoiceFx.java (Android) และ AstraVoiceFx ใน VoiceEnginePlugin.swift (iOS)
(function () {
  const RATE = 16000;
  const NAMES = ["ปกติ", "ยักษ์ (เสียงต่ำ)", "ชิปมังก์ (เสียงสูง)", "หุ่นยนต์", "ปีศาจ", "วิทยุสื่อสาร", "ก้องในถ้ำ", "เด็ก"];
  const PITCH = [1, 0.7, 1.6, 1, 0.58, 1, 1, 1.3];

  function VoiceFx() {
    const N = 4096, W = 1200;
    const buf = new Float32Array(N);
    let w = 0, ph = 0, t = 0;
    const EL = 3200; // ก้อง 0.2 วินาที
    const eb = new Float32Array(EL);
    let ew = 0, hpY = 0, hpX = 0, lp = 0;
    const HP = Math.exp(-2 * Math.PI * 400 / RATE), LP = Math.exp(-2 * Math.PI * 2800 / RATE);

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
    return {
      process(pcm, id) {
        if (!id) return pcm;
        const r = PITCH[id] || 1;
        for (let i = 0; i < pcm.length; i++) {
          let x = pcm[i] / 32768;
          if (r !== 1) x = pitch(x, r);
          switch (id) {
            case 3: x = x * Math.sin(2 * Math.PI * 55 * t / RATE) * 1.6; break;           // หุ่นยนต์
            case 4: x = Math.tanh(x * 1.8) * 0.8; break;                                    // ปีศาจ
            case 5: {                                                                       // วิทยุ
              hpY = HP * (hpY + x - hpX); hpX = x;
              lp = lp + (1 - LP) * (hpY - lp);
              x = Math.tanh(lp * 4) * 0.6; break;
            }
            case 6: { const d = eb[ew]; const y = x + 0.5 * d; eb[ew] = x + 0.4 * d; ew = (ew + 1) % EL; x = y * 0.8; break; } // ก้อง
          }
          t = (t + 1) % RATE;
          let v = Math.round(x * 32767);
          pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
        return pcm;
      },
    };
  }
  window.AstraVfx = { NAMES, create: VoiceFx };
})();
