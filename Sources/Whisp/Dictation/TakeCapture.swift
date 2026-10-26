import AVFoundation

/**
 * One take's audio. The recorder pushes microphone buffers in on the audio
 * thread; this converts them once to 16 kHz mono float, keeps every sample
 * (OpenAI gets a WAV of them at the end), measures loudness for the pill
 * and the silence gate, and forwards each converted buffer to whoever is
 * attached — the on-device recognizer, which may attach a moment after
 * recording starts and is handed the backlog first, so no first word is lost
 * to its warm-up.
 */
nonisolated final class TakeCapture: @unchecked Sendable {
    static let sampleRate = 16_000.0
    static let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
    )!

    /**
     * Speech, for the silence gate: louder than this on the 0…1 level scale
     * (about −41 dBFS RMS), for at least `minVoicedSeconds` in total. Room
     * noise and a breath stay under; a word clears it.
     */
    private static let speechLevel: Float = 0.3
    private static let minVoicedSeconds = 0.15

    private let lock = NSLock()
    private var samples: [Float] = []
    private var voicedSeconds = 0.0
    private var latestLevel: Float = 0
    private var converter: AVAudioConverter?
    private var sink: (@Sendable (AVAudioPCMBuffer) -> Void)?
    private var closed = false

    // MARK: Audio thread

    func append(native buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        append(converted: converted)
    }

    /** Already 16 kHz mono float — the `--transcribe` path feeds files this way. */
    func append(converted buffer: AVAudioPCMBuffer) {
        let count = Int(buffer.frameLength)
        guard count > 0, let channel = buffer.floatChannelData?[0] else { return }
        var sum: Float = 0
        for i in 0..<count { sum += channel[i] * channel[i] }
        let rms = (sum / Float(count)).squareRoot()
        let decibels = 20 * log10(max(rms, 1e-7))
        let level = min(max((decibels + 55) / 45, 0), 1)
        lock.withLock {
            guard !closed else { return }
            samples.append(contentsOf: UnsafeBufferPointer(start: channel, count: count))
            if level > Self.speechLevel { voicedSeconds += Double(count) / Self.sampleRate }
            latestLevel = level
            sink?(buffer)
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: Self.format)
            converter?.downmix = true
        }
        guard let converter else { return nil }
        let ratio = Self.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        return status == .error ? nil : out
    }

    // MARK: Anywhere

    /** Hands the backlog to `sink`, then every buffer after it. */
    func attach(_ sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) {
        lock.withLock {
            if !samples.isEmpty,
               let backlog = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(samples.count)) {
                backlog.frameLength = AVAudioFrameCount(samples.count)
                samples.withUnsafeBufferPointer { src in
                    backlog.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
                }
                sink(backlog)
            }
            self.sink = sink
        }
    }

    /** No more audio: the microphone stopped. */
    func close() {
        lock.withLock {
            closed = true
            sink = nil
        }
    }

    var level: Float { lock.withLock { latestLevel } }
    var duration: Double { lock.withLock { Double(samples.count) / Self.sampleRate } }
    var hasSpeech: Bool { lock.withLock { voicedSeconds >= Self.minVoicedSeconds } }

    /** The take as a 16-bit mono WAV file, for upload. */
    func wavData() -> Data {
        let pcm: [Int16] = lock.withLock {
            samples.map { Int16(max(-1, min(1, $0)) * Float(Int16.max)) }
        }
        let dataSize = UInt32(pcm.count * 2)
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36) + dataSize)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(Self.sampleRate)); put(UInt32(Self.sampleRate) * 2); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(dataSize)
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }
}
