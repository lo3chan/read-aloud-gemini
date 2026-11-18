(function(global) {
  let modulePromise = null;
  let phononPromise = null;
  let activeInstance = null;

  const MALE_VOICE_HINTS = new Set([
    "charon", "fenrir", "puck", "orus", "alnilam", "algenib", "algieba",
    "enceladus", "iapetus", "rasalgethi", "sadachbia", "sadaltager",
    "schedar", "umbriel", "zubenelgenubi", "onyx", "echo", "ryan", "guy", "thomas"
  ]);

  function float32ToWavBytes(samples, sampleRate = 24000) {
    const numSamples = samples.length;
    const dataLength = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const writeAscii = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  function uint8ToBase64(bytes) {
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }

  function resolvePhononVoice(tts, requestedVoice) {
    const voices = Array.isArray(tts && tts.voices) ? tts.voices : [];
    const req = String(requestedVoice || "").trim().replace(/^Gemini\s+/i, "");
    if (req) {
      const lower = req.toLowerCase();
      const exact = voices.find(v =>
        String(v.name || "").toLowerCase() === lower || String(v.id || "").toLowerCase() === lower
      );
      if (exact) return exact.name;
      if (MALE_VOICE_HINTS.has(lower)) {
        const male = voices.find(v => String(v.name || "").toLowerCase() === "easton") ||
          voices.find(v => String(v.gender || "").toLowerCase() === "male");
        if (male) return male.name;
      }
    }
    return (tts && tts.defaultVoice) || "Delia";
  }

  async function ensurePhonon() {
    if (activeInstance) return activeInstance;
    if (phononPromise) return phononPromise;

    phononPromise = (async () => {
      if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU is not available in this browser context.");
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error("No WebGPU adapter found. Check chrome://gpu or enable hardware acceleration.");
      }
      if (!modulePromise) {
        const url = typeof brapi !== "undefined" && brapi.runtime && brapi.runtime.getURL
          ? brapi.runtime.getURL("js/phonon.js")
          : new URL("phonon.js", global.location.href).href;
        modulePromise = import(url);
      }
      const mod = await modulePromise;
      const tts = await mod.Phonon.load({ backend: "webgpu" });
      activeInstance = tts;
      if (tts && tts.lost && typeof tts.lost.then === "function") {
        tts.lost.then(() => {
          if (activeInstance === tts) {
            activeInstance = null;
            phononPromise = null;
          }
        }).catch(() => {});
      }
      return tts;
    })();

    try {
      return await phononPromise;
    } catch (err) {
      phononPromise = null;
      throw err;
    }
  }

  async function synthesize(text, voiceName, speed) {
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      throw new Error("Empty text for Phonon WebGPU synthesis.");
    }
    const tts = await ensurePhonon();
    const voice = resolvePhononVoice(tts, voiceName);
    const numSpeed = Number(speed);
    const clampedSpeed = Number.isFinite(numSpeed) && numSpeed > 0
      ? Math.max(0.77, Math.min(1.3, numSpeed))
      : 1.0;
    const speech = await tts.speak(cleanText, { voice, speed: clampedSpeed });
    if (!speech || !speech.audio || !speech.audio.length) {
      throw new Error("Phonon WebGPU returned empty audio.");
    }
    const bytes = float32ToWavBytes(speech.audio, speech.sampleRate || 24000);
    return { bytes, mimeType: "audio/wav" };
  }

  global.phononBridge = {
    synthesize,
    uint8ToBase64,
    resolvePhononVoice,
    float32ToWavBytes
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
