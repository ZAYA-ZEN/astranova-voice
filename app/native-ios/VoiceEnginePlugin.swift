import Foundation
import AVFoundation
import Capacitor

// MARK: - Capacitor plugin (ชื่อฝั่ง JS: VoiceEngine)
@objc(VoiceEnginePlugin)
public class VoiceEnginePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceEnginePlugin"
    public let jsName = "VoiceEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOpts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDevices", returnType: CAPPluginReturnPromise),
    ]

    private let eng = AstraVoiceEngine.shared

    override public func load() {
        eng.emit = { [weak self] ev in
            DispatchQueue.main.async { self?.notifyListeners("event", data: ev) }
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { call.reject("ที่อยู่ไม่ถูกต้อง"); return }
        eng.connect(url: url, hello: call.getString("hello") ?? "")
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        eng.sendText(call.getString("text") ?? "")
        call.resolve()
    }

    @objc func close(_ call: CAPPluginCall) {
        eng.close()
        call.resolve()
    }

    @objc func startAudio(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                if !granted { call.reject("ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน (ไปที่ ตั้งค่า > Astra Nova Voice > ไมโครโฟน)"); return }
                do { try self.eng.startAudio(); call.resolve() }
                catch { call.reject("เริ่มเสียงไม่ได้: \(error.localizedDescription)") }
            }
        }
    }

    @objc func listDevices(_ call: CAPPluginCall) {
        call.resolve(eng.listDevices())
    }

    @objc func stopAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.eng.stopAudio(); call.resolve() }
    }

    @objc func setOpts(_ call: CAPPluginCall) {
        if let v = call.getBool("active") { eng.active = v }
        if let v = call.getBool("muted") { eng.muted = v }
        if let v = call.getBool("deaf") { eng.deaf = v }
        if let v = call.getBool("ptt") { eng.ptt = v }
        if let v = call.getBool("pttDown") { eng.pttDown = v }
        if let v = call.getDouble("threshold") { eng.threshold = Float(v) }
        if let v = call.getDouble("boost") { eng.boost = Float(v) }
        if let v = call.getInt("vfx") { eng.vfxId = v }
        if let v = call.getDouble("vol") { eng.vol = Float(v) }
        if let v = call.getBool("echoGate") { eng.echoGate = v }
        if let v = call.getString("inputId"), v != eng.inputId { eng.inputId = v; DispatchQueue.main.async { self.eng.applyDevices() } }
        if let v = call.getString("outputId"), v != eng.outputId { eng.outputId = v; DispatchQueue.main.async { self.eng.applyDevices() } }
        if let m = call.getObject("spkVol") {
            var d: [Int: Float] = [:]
            for (k, v) in m { if let i = Int(k), let n = v as? NSNumber { d[i] = n.floatValue } }
            eng.spkVolLock.lock(); eng.spkVol = d; eng.spkVolLock.unlock()
        }
        DispatchQueue.main.async { self.eng.applyVolume() }
        call.resolve()
    }
}

// MARK: - Engine: WebSocket + AVAudioEngine (ทำงานเบื้องหลังด้วย UIBackgroundModes=audio)
final class AstraVoiceEngine: NSObject, URLSessionWebSocketDelegate {
    static let shared = AstraVoiceEngine()
    static let RATE: Double = 16000
    static let FRAME = 640

    var emit: (([String: Any]) -> Void)?

    // ค่าจาก UI
    var active = false, muted = false, deaf = false, ptt = false, pttDown = false
    var threshold: Float = 0.02, boost: Float = 1, vol: Float = 1
    var vfxId = 0 // ตัวเปลี่ยนเสียง (แอดมิน)
    private let vfx = AstraVoiceFx()
    var echoGate = true
    var inputId = "", outputId = ""
    var spkVol: [Int: Float] = [:]
    let spkVolLock = NSLock()
    private let adpcmEnc = Adpcm()
    private var remoteLvl: Float = 0
    private var remoteUntil: TimeInterval = 0

    // WebSocket
    private let opQueue: OperationQueue = { let q = OperationQueue(); q.maxConcurrentOperationCount = 1; return q }()
    private lazy var session: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: opQueue)
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var hello = ""
    private var want = false
    private(set) var isOpen = false
    private var pingTimer: Timer?

    // Audio
    private let engine = AVAudioEngine()
    private let fmt16 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: RATE, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var monoInFmt: AVAudioFormat?
    private var pending: [Float] = []
    private var prevFrame: [Int16]?
    private func packAdpcm(_ pcm: [Int16]) -> Data {
        var out = Data([1])
        out.append(contentsOf: adpcmEnc.encode(pcm))
        return out
    }
    private var hangUntil: TimeInterval = 0
    private var transmitting = false
    private var lastLevel: TimeInterval = 0
    private var running = false

    private final class Spk { let node = AVAudioPlayerNode(); var queued = 0; var last = Date() }
    private var speakers: [Int: Spk] = [:]
    private var filters: [Int: (Float, Float)] = [:]
    private let filterLock = NSLock()
    private let spkLock = NSLock()

    private func ev(_ type: String, _ extra: [String: Any] = [:]) {
        var d = extra; d["type"] = type; emit?(d)
    }

    // MARK: WebSocket
    func connect(url: URL, hello: String) {
        opQueue.addOperation {
            self.url = url; self.want = true
            // บอกเซิร์ฟเวอร์ว่าเครื่องนี้ใช้ ADPCM (บีบอัด 4 เท่า)
            if let d = hello.data(using: .utf8), var obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                obj["codecs"] = ["enc": ["adpcm"], "dec": ["adpcm"]]
                if let nd = try? JSONSerialization.data(withJSONObject: obj), let ns = String(data: nd, encoding: .utf8) { self.hello = ns } else { self.hello = hello }
            } else { self.hello = hello }
            self.openSocket()
        }
    }

    private func openSocket() {
        guard want, let url = url else { return }
        task?.cancel(with: .goingAway, reason: nil)
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 1 << 20
        task = t
        t.resume()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self, t === self.task else { return }
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s):
                    if s.hasPrefix("{\"t\":\"enc\"") { self.ev("codec", ["name": "ADPCM"]) }
                    else { self.ev("msg", ["data": s]) }
                case .data(let d): self.onAudio(d)
                @unknown default: break
                }
                self.receive(t)
            case .failure:
                self.dropped(t)
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        isOpen = true
        webSocketTask.send(.string(hello)) { _ in }
        ev("open")
        DispatchQueue.main.async {
            self.pingTimer?.invalidate()
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                self?.task?.sendPing { _ in }
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        dropped(webSocketTask)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let w = task as? URLSessionWebSocketTask { dropped(w) }
    }

    private func dropped(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        task = nil
        if isOpen || want { isOpen = false; ev("close") }
        if want {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.opQueue.addOperation { if let s = self, s.want, s.task == nil { s.openSocket() } }
            }
        }
    }

    func sendText(_ s: String) {
        opQueue.addOperation { if self.isOpen { self.task?.send(.string(s)) { _ in } } }
    }

    func close() {
        opQueue.addOperation {
            self.want = false; self.isOpen = false
            let t = self.task; self.task = nil
            t?.cancel(with: .normalClosure, reason: nil)
        }
        DispatchQueue.main.async { self.pingTimer?.invalidate(); self.pingTimer = nil }
    }

    // MARK: Audio
    func startAudio() throws {
        if running { return }
        let s = AVAudioSession.sharedInstance()
        do {
            // voiceChat = ตัดเสียงสะท้อนเต็มที่ (แบบ Discord/โทร)
            try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
        } catch {
            try s.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        }
        try s.setPreferredIOBufferDuration(0.02)
        try s.setActive(true)

        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch { } // ตัดเสียงสะท้อน
        if #available(iOS 17.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFmt.sampleRate, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: mono, to: fmt16) else {
            throw NSError(domain: "AstraVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "ไม่พบไมโครโฟน"])
        }
        monoInFmt = mono
        converter = conv
        pending.removeAll()
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFmt) { [weak self] buf, _ in self?.onInput(buf) }

        _ = engine.mainMixerNode
        engine.prepare()
        try engine.start()
        running = true
        applyVolume()
        applyDevices()

        let nc = NotificationCenter.default
        nc.removeObserver(self)
        nc.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(onReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        nc.addObserver(self, selector: #selector(onConfigChange(_:)), name: .AVAudioEngineConfigurationChange, object: engine)
    }

    func stopAudio() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        spkLock.lock()
        for (_, s) in speakers { engine.detach(s.node) }
        speakers.removeAll()
        spkLock.unlock()
        NotificationCenter.default.removeObserver(self)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: อุปกรณ์เสียง
    func listDevices() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        let ins = (s.availableInputs ?? []).map { ["id": $0.uid, "name": $0.portName] }
        let outs: [[String: String]] = [["id": "speaker", "name": "ลำโพงเครื่อง"], ["id": "receiver", "name": "ลำโพงสนทนา / หูฟังที่เสียบ"]]
        return ["inputs": ins, "outputs": outs]
    }
    func applyDevices() {
        let s = AVAudioSession.sharedInstance()
        if inputId.isEmpty { try? s.setPreferredInput(nil) }
        else if let port = s.availableInputs?.first(where: { $0.uid == inputId }) { try? s.setPreferredInput(port) }
        if outputId == "speaker" { try? s.overrideOutputAudioPort(.speaker) }
        else { try? s.overrideOutputAudioPort(.none) }
    }

    func applyVolume() {
        engine.mainMixerNode.outputVolume = deaf ? 0 : vol
    }

    @objc private func onInterruption(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.restart() } }
    }
    @objc private func onReset(_ n: Notification) { DispatchQueue.main.async { self.restart() } }
    @objc private func onConfigChange(_ n: Notification) { DispatchQueue.main.async { self.restart() } }

    private var lastRestart = Date.distantPast
    private func restart() {
        guard running, Date().timeIntervalSince(lastRestart) > 2 else { return }
        lastRestart = Date()
        stopAudio()
        do { try startAudio() } catch { ev("error", ["message": "เสียงหลุด: \(error.localizedDescription)"]) }
    }

    private func onInput(_ buf: AVAudioPCMBuffer) {
        guard let src = buf.floatChannelData?[0], let mono = monoInFmt, let conv = converter else { return }
        let n = Int(buf.frameLength)
        guard n > 0, let mb = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(n)) else { return }
        memcpy(mb.floatChannelData![0], src, n * MemoryLayout<Float>.size)
        mb.frameLength = AVAudioFrameCount(n)
        let cap = AVAudioFrameCount(Double(n) * AstraVoiceEngine.RATE / mono.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return mb
        }
        let m = Int(out.frameLength)
        if m == 0 { return }
        let p = out.floatChannelData![0]
        pending.append(contentsOf: UnsafeBufferPointer(start: p, count: m))
        while pending.count >= AstraVoiceEngine.FRAME {
            let frame = Array(pending[0..<AstraVoiceEngine.FRAME])
            pending.removeFirst(AstraVoiceEngine.FRAME)
            processFrame(frame)
        }
    }

    private func processFrame(_ f: [Float]) {
        var sum: Float = 0
        var pcm = [Int16](repeating: 0, count: f.count)
        let b = boost
        for i in 0..<f.count {
            var v = f[i] * b
            if v > 1 { v = 1 } else if v < -1 { v = -1 }
            sum += v * v
            pcm[i] = Int16(v * 32767)
        }
        let rms = sqrt(sum / Float(f.count))
        let now = Date().timeIntervalSince1970
        var tx = false
        if active && !muted && isOpen {
            if ptt { tx = pttDown }
            else {
                var th = threshold
                // กันเสียงสะท้อน: ขณะได้ยินคนอื่น ต้องพูดดังกว่าเสียงที่ย้อนเข้าไมค์
                if echoGate && now < remoteUntil { th = max(th * 3, remoteLvl * 0.6) }
                if rms > th { hangUntil = now + 0.45 }
                tx = now < hangUntil
            }
        }
        if vfxId > 0 { vfx.process(&pcm, vfxId) }
        if tx, let t = task {
            if !transmitting, !ptt, let prev = prevFrame { t.send(.data(packAdpcm(prev))) { _ in } }
            t.send(.data(packAdpcm(pcm))) { _ in }
        }
        transmitting = tx
        prevFrame = pcm
        if now - lastLevel > 0.1 {
            lastLevel = now
            ev("level", ["rms": rms, "tx": tx])
        }
    }

    // เสียงจากคนอื่น: [u16 slot][u8 gain][i8 pan][PCM16...]
    private func onAudio(_ d: Data) {
        guard running, !deaf, d.count >= 7 else { return }
        let bytes = [UInt8](d)
        let slot = Int(bytes[0]) | (Int(bytes[1]) << 8)
        spkVolLock.lock(); let mult = spkVol[slot] ?? 1; spkVolLock.unlock()
        let gain = Float(bytes[2]) / 255 * mult
        let pan = Float(Int8(bitPattern: bytes[3])) / 127
        let cutoff = Float(bytes[4]) * 50
        let codec = bytes[5]
        let samples: [Int16]
        if codec == 1 { samples = Adpcm.decode(bytes, offset: 6, count: AstraVoiceEngine.FRAME) }
        else if codec == 0 {
            let cnt = (bytes.count - 6) / 2
            samples = (0..<cnt).map { Int16(bitPattern: UInt16(bytes[6 + 2 * $0]) | (UInt16(bytes[7 + 2 * $0]) << 8)) }
        } else { return }
        let n = samples.count
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: AVAudioFrameCount(n)) else { return }
        let p = buf.floatChannelData![0]
        // ตัวกรองเสียงทึบ (ผนัง/ใต้น้ำ): low-pass 2 ชั้น เก็บสถานะต่อคน
        filterLock.lock()
        var st = filters[slot] ?? (0, 0)
        let a: Float = cutoff > 0 ? 1 - exp(-2 * Float.pi * cutoff / Float(AstraVoiceEngine.RATE)) : 1
        let boostOut: Float = gain > 1 ? gain : 1 // ปรับรายคนเกิน 100% → ขยายที่ตัวเสียง
        var sq: Float = 0
        for i in 0..<n {
            let x = Float(samples[i]) / 32768
            st.0 += a * (x - st.0)
            st.1 += a * (st.0 - st.1)
            let y = max(-1, min(1, st.1 * boostOut))
            p[i] = y; sq += y * y
        }
        filters[slot] = st
        filterLock.unlock()
        let lvl = sqrt(sq / Float(max(n, 1))) * min(1, gain) * vol
        let nowT = Date().timeIntervalSince1970
        remoteLvl = nowT < remoteUntil ? max(remoteLvl * 0.9, lvl) : lvl
        remoteUntil = nowT + 0.25
        buf.frameLength = AVAudioFrameCount(n)

        DispatchQueue.main.async {
            guard self.running else { return }
            self.spkLock.lock()
            var sp = self.speakers[slot]
            if sp == nil {
                let s = Spk()
                self.engine.attach(s.node)
                self.engine.connect(s.node, to: self.engine.mainMixerNode, format: self.fmt16)
                s.node.play()
                self.speakers[slot] = s
                sp = s
            }
            let s = sp!
            self.spkLock.unlock()
            s.node.volume = min(1, gain)
            s.node.pan = pan
            s.last = Date()
            if s.queued > 8 { return } // ดีเลย์สะสม → ทิ้งเฟรม
            if s.queued == 0, let pad = AVAudioPCMBuffer(pcmFormat: self.fmt16, frameCapacity: 1280) {
                pad.frameLength = 1280 // เผื่อเน็ตกระตุก ~80ms
                memset(pad.floatChannelData![0], 0, 1280 * MemoryLayout<Float>.size)
                s.queued += 1
                s.node.scheduleBuffer(pad) { DispatchQueue.main.async { s.queued -= 1 } }
            }
            s.queued += 1
            s.node.scheduleBuffer(buf) { DispatchQueue.main.async { s.queued -= 1 } }
            self.pruneSpeakers()
        }
    }

    private func pruneSpeakers() {
        let now = Date()
        spkLock.lock()
        for (k, s) in speakers where now.timeIntervalSince(s.last) > 15 {
            s.node.stop(); engine.detach(s.node); speakers.removeValue(forKey: k)
        }
        spkLock.unlock()
    }
}


// MARK: - ตัวเปลี่ยนเสียง (แอดมิน) — ต้องตรงกับ www/vfx.js
final class AstraVoiceFx {
    private static let RATE = 16000.0, N = 4096, W = 1200.0, EL = 3200
    private static let PITCH: [Float] = [1, 0.7, 1.6, 1, 0.58, 1, 1, 1.3]
    private let HP = exp(-2 * Double.pi * 400 / 16000), LP = exp(-2 * Double.pi * 2800 / 16000)
    private var buf = [Float](repeating: 0, count: 4096)
    private var eb = [Float](repeating: 0, count: 3200)
    private var w = 0, ew = 0, t = 0
    private var ph = 0.0, hpY = 0.0, hpX = 0.0, lp = 0.0

    private func tap(_ p: Double) -> Float {
        var pos = Double(w) - (p * AstraVoiceFx.W + 1)
        while pos < 0 { pos += Double(AstraVoiceFx.N) }
        let i = Int(pos.rounded(.down)), f = Float(pos - Double(i))
        let a = buf[i % AstraVoiceFx.N], b = buf[(i + 1) % AstraVoiceFx.N]
        return a + (b - a) * f
    }
    private func pitch(_ x: Float, _ r: Float) -> Float {
        buf[w] = x
        ph += Double(1 - r) / AstraVoiceFx.W
        ph -= ph.rounded(.down)
        let p2 = (ph + 0.5).truncatingRemainder(dividingBy: 1)
        let s1 = sin(Double.pi * ph), s2 = sin(Double.pi * p2)
        let y = Float(Double(tap(ph)) * s1 * s1 + Double(tap(p2)) * s2 * s2)
        w = (w + 1) % AstraVoiceFx.N
        return y
    }
    func process(_ pcm: inout [Int16], _ id: Int) {
        guard id > 0, id < AstraVoiceFx.PITCH.count else { return }
        let r = AstraVoiceFx.PITCH[id]
        for i in 0..<pcm.count {
            var x = Float(pcm[i]) / 32768
            if r != 1 { x = pitch(x, r) }
            switch id {
            case 3: x = Float(Double(x) * sin(2 * Double.pi * 55 * Double(t) / AstraVoiceFx.RATE) * 1.6)
            case 4: x = tanhf(x * 1.8) * 0.8
            case 5:
                hpY = HP * (hpY + Double(x) - hpX); hpX = Double(x)
                lp = lp + (1 - LP) * (hpY - lp)
                x = Float(tanh(lp * 4) * 0.6)
            case 6:
                let d = eb[ew]; let y = x + 0.5 * d; eb[ew] = x + 0.4 * d; ew = (ew + 1) % AstraVoiceFx.EL; x = y * 0.8
            default: break
            }
            t = (t + 1) % Int(AstraVoiceFx.RATE)
            let v = Int((x * 32767).rounded())
            pcm[i] = Int16(max(-32768, min(32767, v)))
        }
    }
}
