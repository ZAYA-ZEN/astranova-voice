import Foundation

/// IMA-ADPCM แบบเดียวกับ www/codec.js และ Adpcm.java
final class Adpcm {
    private static let IT: [Int] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
    private static let ST: [Int] = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]
    private var encIdx = 0

    private static func clamp(_ v: Int) -> Int { return v > 32767 ? 32767 : (v < -32768 ? -32768 : v) }

    func encode(_ pcm: [Int16]) -> [UInt8] {
        let n = pcm.count
        var out = [UInt8](repeating: 0, count: 3 + (n >> 1))
        var pred = Int(pcm[0]), idx = encIdx
        out[0] = UInt8(truncatingIfNeeded: pred); out[1] = UInt8(truncatingIfNeeded: pred >> 8); out[2] = UInt8(idx)
        for i in 1..<n {
            var step = Adpcm.ST[idx], diff = Int(pcm[i]) - pred, sign = 0
            if diff < 0 { sign = 8; diff = -diff }
            var nib = 0, vp = step >> 3
            if diff >= step { nib = 4; diff -= step; vp += step }
            step >>= 1; if diff >= step { nib |= 2; diff -= step; vp += step }
            step >>= 1; if diff >= step { nib |= 1; vp += step }
            pred = Adpcm.clamp(sign != 0 ? pred - vp : pred + vp)
            nib |= sign
            idx += Adpcm.IT[nib]; if idx < 0 { idx = 0 } else if idx > 88 { idx = 88 }
            let j = i - 1, b = 3 + (j >> 1)
            if j & 1 != 0 { out[b] |= UInt8(nib << 4) } else { out[b] = UInt8(nib) }
        }
        encIdx = idx
        return out
    }

    static func decode(_ bytes: [UInt8], offset: Int, count n: Int) -> [Int16] {
        var out = [Int16](repeating: 0, count: n)
        guard bytes.count >= offset + 3 else { return out }
        var pred = Int(Int16(bitPattern: UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)))
        var idx = min(88, Int(bytes[offset + 2]))
        out[0] = Int16(pred)
        for i in 1..<n {
            let j = i - 1, bi = offset + 3 + (j >> 1)
            if bi >= bytes.count { break }
            let b = Int(bytes[bi])
            let nib = j & 1 != 0 ? b >> 4 : b & 15
            let step = ST[idx]
            var vp = step >> 3
            if nib & 4 != 0 { vp += step }
            if nib & 2 != 0 { vp += step >> 1 }
            if nib & 1 != 0 { vp += step >> 2 }
            pred = clamp(nib & 8 != 0 ? pred - vp : pred + vp)
            out[i] = Int16(pred)
            idx += IT[nib]; if idx < 0 { idx = 0 } else if idx > 88 { idx = 88 }
        }
        return out
    }
}
