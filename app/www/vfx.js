// ตัวแปลงเสียงแบบปรับค่าได้ + ตัดเสียงรบกวนแบบแรง
// ทำงานกับเสียง PCM16 16kHz ทีละเฟรม ก่อนบีบอัดส่งออก
// สูตรเสียงมาจากเซิร์ฟเวอร์ (server/voices.js) เป็นอาร์เรย์ 23 ค่า เรียงตาม FX_KEYS
// ต้องตรงกับ VoiceFx.java (Android) และ AstraVoiceFx ใน VoiceEnginePlugin.swift (iOS)
(function () {
  const RATE = 16000, TAU = 2 * Math.PI;
  const co = (f) => Math.exp(-TAU * f / RATE);

  // ตัวเปลี่ยนระดับเสียงแบบหน้าต่างหน่วงเวลา 2 หัวอ่าน
  function Shifter() {
    const N = 4096, W = 1200, buf = new Float32Array(N);
    let w = 0, ph = 0;
    function tap(p) {
      let pos = w - (p * W + 1);
      while (pos < 0) pos += N;
      const i = Math.floor(pos), f = pos - i;
      const a = buf[i % N], b = buf[(i + 1) % N];
      return a + (b - a) * f;
    }
    return function (x, r) {
      buf[w] = x;
      ph += (1 - r) / W;
      ph -= Math.floor(ph);
      const p2 = (ph + 0.5) % 1;
      const s1 = Math.sin(Math.PI * ph), s2 = Math.sin(Math.PI * p2);
      const y = tap(ph) * s1 * s1 + tap(p2) * s2 * s2;
      w = (w + 1) % N;
      return y;
    };
  }

  // ฟิลเตอร์ biquad (สูตร RBJ) — type: 0 lowpass, 1 highpass, 2 bandpass
  function Biquad() {
    let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return {
      set(type, f, q) {
        f = Math.min(Math.max(f, 20), RATE * 0.45);
        const w0 = TAU * f / RATE, c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
        let n0, n1, n2;
        if (type === 0) { n0 = (1 - c) / 2; n1 = 1 - c; n2 = (1 - c) / 2; }
        else if (type === 1) { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = (1 + c) / 2; }
        else { n0 = al; n1 = 0; n2 = -al; }
        const a0 = 1 + al;
        b0 = n0 / a0; b1 = n1 / a0; b2 = n2 / a0; a1 = (-2 * c) / a0; a2 = (1 - al) / a0;
      },
      run(x) {
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
      },
    };
  }

  function VoiceFx() {
    const sh1 = Shifter(), sh2 = Shifter();
    const hpF = Biquad(), lpF = Biquad(), pkF = Biquad();
    const EL = 8000, eb = new Float32Array(EL); // หน่วงได้สูงสุด 500ms
    let ew = 0, vibPh = 0, ringPh = 0, tremPh = 0, low = 0, env = 0, held = 0, hold = 0, rnd = 12345;
    const LOWC = co(900);
    let key = "", P = null;
    // ตัดเสียงรบกวนแบบแรง
    let dnY = 0, dnX = 0, dnG = 1;
    const DN_HP = co(120);

    function load(fx) {
      const k = fx.join(",");
      if (k === key) return;
      key = k; P = fx;
      if (P[7] > 0) hpF.set(1, P[7], 0.707);
      if (P[8] > 0) lpF.set(0, P[8], 0.707);
      if (P[9] > 0) pkF.set(2, P[9], 1.5);
    }

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
      // fx = อาร์เรย์ 23 ค่าจากเซิร์ฟเวอร์ (null = ไม่เปลี่ยนเสียง)
      process(pcm, fx) {
        if (!fx || fx.length < 23) return pcm;
        load(fx);
        const [pitch, vibRate, vibDepth, dbl, dblMix, ringHz, ringMix, hp, lp, peakHz, peakGain, drive, bits, down,
          tremRate, tremDepth, echoMs, echoFb, echoMix, noise, gain, bass, treble] = P;
        const ed = Math.min(EL - 1, Math.max(1, Math.round(echoMs * RATE / 1000)));
        const q = bits > 0 ? Math.pow(2, bits - 1) : 0, dn = Math.max(1, Math.round(down));
        const dTanh = drive > 0 ? Math.tanh(drive) : 1;
        for (let i = 0; i < pcm.length; i++) {
          let x = pcm[i] / 32768;
          // 1) ระดับเสียง + เสียงสั่น
          let r = pitch;
          if (vibRate > 0) { vibPh += vibRate / RATE; vibPh -= Math.floor(vibPh); r *= 1 + vibDepth * Math.sin(TAU * vibPh); }
          const dry = x;
          if (r !== 1) x = sh1(x, r);
          // 2) เสียงที่สองซ้อน
          if (dbl > 0) x = x * (1 - dblMix * 0.5) + sh2(dry, dbl) * dblMix;
          // 3) ทุ้ม/แหลม
          if (bass !== 1 || treble !== 1) { low += (1 - LOWC) * (x - low); x = low * bass + (x - low) * treble; }
          // 4) ตัดย่านเสียง + เน้นย่าน
          if (hp > 0) x = hpF.run(x);
          if (lp > 0) x = lpF.run(x);
          if (peakHz > 0) x += pkF.run(x) * peakGain;
          // 5) หุ่นยนต์
          if (ringHz > 0) { ringPh += ringHz / RATE; ringPh -= Math.floor(ringPh); x = x * (1 - ringMix) + x * Math.sin(TAU * ringPh) * ringMix * 1.4; }
          // 6) เสียงแตก + ลดคุณภาพ
          if (drive > 0) x = Math.tanh(x * drive) / dTanh;
          if (q > 0) x = Math.round(x * q) / q;
          if (dn > 1) { if (hold <= 0) { held = x; hold = dn; } hold--; x = held; }
          // 7) เสียงขาดๆ หายๆ
          if (tremRate > 0) { tremPh += tremRate / RATE; tremPh -= Math.floor(tremPh); x *= 1 - tremDepth * 0.5 * (1 - Math.sin(TAU * tremPh)); }
          // 8) เสียงลม/กระซิบ ตามความดังของเสียงพูด
          if (noise > 0) {
            const a = Math.abs(dry); env += (a > env ? 0.05 : 0.002) * (a - env);
            rnd = (Math.imul(rnd, 1103515245) + 12345) & 0x7fffffff;
            x += noise * env * 3 * (rnd / 0x3fffffff - 1);
          }
          // 9) เสียงก้อง
          if (echoMs > 0) {
            let rp = ew - ed; if (rp < 0) rp += EL;
            const d = eb[rp];
            eb[ew] = x + echoFb * d;
            ew = (ew + 1) % EL;
            x = x + echoMix * d;
          }
          x *= gain;
          const v = Math.round(x * 32767);
          pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
        return pcm;
      },
    };
  }
  window.AstraVfx = { create: VoiceFx };
})();
