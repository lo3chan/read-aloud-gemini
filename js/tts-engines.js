
//synthesized audio cache
const cache = {
  entries: new Map(),
  maxEntries: 8,
  has(key) {
    return this.entries.has(key);
  },
  fetchCached(key, fetchFn, destroyFn) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.promise;
    }
    const promise = Promise.resolve().then(fetchFn).catch(err => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
      throw err;
    });
    this.entries.set(key, {promise, destroyFn});
    while (this.entries.size > this.maxEntries) {
      const [oldestKey, oldest] = this.entries.entries().next().value;
      oldest.promise.then(value => oldest.destroyFn?.(value)).catch(() => {});
      this.entries.delete(oldestKey);
    }
    return promise;
  },
  clear() {
    for (const [, entry] of this.entries) {
      entry.promise.then(value => entry.destroyFn?.(value)).catch(() => {});
    }
    this.entries.clear();
  }
};


function DummyTtsEngine() {
  this.speak = function() {
    return rxjs.EMPTY;
  };
  this.getVoices = function() {
    return Promise.resolve([]);
  };
}


const GEMINI_PREBUILT_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam",
  "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina",
  "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus",
  "Kore", "Laomedeia", "Leda", "Orus", "Puck",
  "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar",
  "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi"
];

const GEMINI_DEFAULT_CONFIG = {
  backend: "gemini-api",
  apiKey: "",
  model: "gemini-3.8-flash-lite-tts",
  languageCode: "en-gb",
  audioEncoding: "MP3",
  chunkSize: 750,
  prompt: "Speak with a natural, warm Scottish accent."
};


function GeminiTtsEngine() {
  this.prebuiltVoices = GEMINI_PREBUILT_VOICES;
  this.defaultConfig = GEMINI_DEFAULT_CONFIG;
  this.maxTelemetryEntries = 100;

  let telemetryQueue = Promise.resolve();

  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options);
    const playFn = typeof playAudio !== "undefined" ? playAudio : playAudioHere;
    return playFn(urlPromise, options, playbackState$);
  };

  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options).catch(console.error);
  };

  this.getVoices = async function() {
    const creds = await getNormalizedCreds();
    return GEMINI_PREBUILT_VOICES.map(voice => ({
      voiceName: "Gemini " + voice,
      lang: creds.languageCode || "en-gb",
      langs: [creds.languageCode || "en-gb"],
      geminiVoice: voice
    }));
  };

  this.test = async function(rawCreds, sampleText, voiceName) {
    const creds = normalizeCreds(rawCreds);
    if (creds.backend !== "portal" && creds.backend !== "google-translate" && creds.backend !== "phonon-webgpu" && creds.backend !== "edge-tts" && !creds.apiKey) {
      throw new Error("API key is required for this backend.");
    }
    const voice = voiceName || "Achernar";
    const text = sampleText || "Hello! This is a test of the Gemini Scottish text to speech voice.";
    return synthesizeWithTelemetry(text, creds, voice, {});
  };

  this.clearCache = function() {
    cache.clear();
  };

  this.getTelemetry = async function() {
    const data = await getSettings(["geminiTelemetry"]);
    return Array.isArray(data.geminiTelemetry) ? data.geminiTelemetry : [];
  };

  this.clearTelemetry = async function() {
    await updateSettings({geminiTelemetry: []});
  };

  this.pcmToWavBytes = pcmToWavBytes;
  this.parsePcmSampleRate = parsePcmSampleRate;
  this.buildCloudTtsRequest = buildCloudTtsRequest;
  this.buildGeminiApiRequest = buildGeminiApiRequest;

  async function getNormalizedCreds() {
    const {geminiCreds} = await getSettings(["geminiCreds"]);
    return normalizeCreds(geminiCreds);
  }

  function normalizeCreds(raw) {
    const src = raw || {};
    const backend = (src.backend === "cloud-tts" || src.backend === "portal" || src.backend === "google-translate" || src.backend === "phonon-webgpu" || src.backend === "edge-tts")
      ? src.backend
      : "gemini-api";
    const prompt = src.prompt != null
      ? String(src.prompt)
      : (src.defaultPrompt != null ? String(src.defaultPrompt) : GEMINI_DEFAULT_CONFIG.prompt);
    return {
      backend,
      apiKey: (src.apiKey || "").trim(),
      model: (src.model || GEMINI_DEFAULT_CONFIG.model).trim(),
      languageCode: (src.languageCode || GEMINI_DEFAULT_CONFIG.languageCode).trim(),
      audioEncoding: src.audioEncoding || GEMINI_DEFAULT_CONFIG.audioEncoding,
      chunkSize: Math.max(100, Math.min(4000, Number(src.chunkSize ?? GEMINI_DEFAULT_CONFIG.chunkSize) || 750)),
      prompt
    };
  }

  function resolveVoiceName(voice) {
    if (voice && voice.geminiVoice) return voice.geminiVoice;
    if (voice && voice.voiceName) return voice.voiceName.replace(/^Gemini\s+/, "");
    return "Achernar";
  }

  function buildCloudTtsRequest(text, creds, voiceName) {
    const prompt = creds.disableModelName ? "" : (creds.prompt || "").trim();
    const input = prompt ? {prompt, text} : {text};
    const voice = {
      languageCode: creds.languageCode || "en-gb",
      name: voiceName || "Achernar"
    };
    if (!creds.disableModelName) {
      voice.modelName = creds.model || GEMINI_DEFAULT_CONFIG.model;
    }
    return {
      audioConfig: {
        audioEncoding: creds.audioEncoding || "MP3",
        pitch: 0,
        speakingRate: 1.0
      },
      input,
      voice
    };
  }

  function buildGeminiApiRequest(text, creds, voiceName) {
    const prompt = (creds.prompt || "").trim();
    const combinedText = prompt ? prompt + "\n\n" + text : text;
    return {
      contents: [
        {
          parts: [{text: combinedText}]
        }
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName || "Achernar"
            }
          }
        }
      }
    };
  }

  function getAudioUrl(text, options) {
    assert(text && options && options.voice);
    return getNormalizedCreds().then(creds => {
      if (creds.backend !== "portal" && creds.backend !== "google-translate" && creds.backend !== "phonon-webgpu" && creds.backend !== "edge-tts" && !creds.apiKey) {
        throw new Error(JSON.stringify({code: "error_gemini_not_configured"}));
      }
      const voiceName = resolveVoiceName(options.voice);
      const cacheKey = JSON.stringify([
        "v2",
        text,
        creds.backend,
        creds.model,
        voiceName,
        creds.languageCode,
        creds.prompt,
        creds.audioEncoding
      ]);

      if (cache.has(cacheKey)) {
        recordTelemetry({
          status: "cache_hit",
          backend: creds.backend,
          model: creds.model,
          voice: voiceName,
          languageCode: creds.languageCode,
          prompt: creds.prompt,
          textLength: text.length,
          textPreview: text.slice(0, 80),
          durationMs: 0,
          httpStatus: null,
          mimeType: "cached",
          audioBytes: 0,
          error: null
        });
      }

      return cache.fetchCached(
        cacheKey,
        () => synthesizeWithTelemetry(text, creds, voiceName, options).then(res => res.url),
        blobUrl => {
          if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(blobUrl);
        }
      );
    });
  }

  function isSafetyFilterError(err) {
    return !!(err && err.httpStatus === 400 && /usage guidelines|safety|54702341/i.test(err.message || ""));
  }

  function canRetryWithoutPrompt(err, creds) {
    return isSafetyFilterError(err);
  }

  function pickFallbackCloudVoice(languageCode) {
    const lang = String(languageCode || "en-gb").toLowerCase();
    if (lang.startsWith("en-us")) return {languageCode: "en-US", name: "en-US-Standard-C"};
    if (lang.startsWith("en-au")) return {languageCode: "en-AU", name: "en-AU-Standard-A"};
    return {languageCode: "en-GB", name: "en-GB-Standard-A"};
  }

  function createSilentWavResult() {
    const pcm = new Uint8Array(Math.floor(24000 * 2 * 0.15));
    const wavBytes = pcmToWavBytes(pcm, 24000, 1, 16);
    const blob = new Blob([wavBytes], {type: "audio/wav"});
    return {
      httpStatus: 200,
      mimeType: "audio/wav",
      audioBytes: wavBytes.byteLength,
      url: URL.createObjectURL(blob)
    };
  }

  async function runBackendSynthesis(cleanText, creds, voiceName, model, options) {
    async function execute() {
      if (creds.backend === "cloud-tts") {
        return callCloudTts(cleanText, creds, voiceName, options);
      } else if (creds.backend === "portal") {
        return callPortalTts(cleanText, creds, voiceName, options);
      } else if (creds.backend === "google-translate") {
        return callGoogleTranslateTts(cleanText, creds, options);
      } else if (creds.backend === "phonon-webgpu") {
        return callPhononWebGpu(cleanText, creds, voiceName, options);
      } else if (creds.backend === "edge-tts") {
        return callEdgeTts(cleanText, creds, voiceName, options);
      }
      return callGeminiApi(cleanText, creds, voiceName, model, options);
    }

    try {
      return await execute();
    } catch (err) {
      const isTransientStatus = err && (err.httpStatus === 429 || err.httpStatus === 502 || err.httpStatus === 503);
      const isNetworkError = err && (!err.httpStatus || err.name === "TypeError" || /network|fetch|timeout|abort|connection/i.test(err.message || ""));
      if (isTransientStatus || isNetworkError) {
        await new Promise(resolve => setTimeout(resolve, 600));
        return await execute();
      }
      throw err;
    }
  }

  async function synthesizeWithTelemetry(text, creds, voiceName, options) {
    const start = Date.now();
    const cleanText = String(text || "").trim() || String(text || "");
    const model = creds.model || GEMINI_DEFAULT_CONFIG.model;
    const languageCode = creds.languageCode || "en-gb";
    const prompt = creds.prompt || "";
    let httpStatus = null;
    let usedVoice = voiceName;
    let usedModel = model;
    let fallbackNote = null;

    try {
      let activeCreds = creds;
      let activeModel = model;
      let result;
      try {
        result = await runBackendSynthesis(cleanText, activeCreds, voiceName, activeModel, options);
      } catch (firstErr) {
        if (
          (creds.backend === "portal" || creds.backend === "cloud-tts")
          && firstErr.httpStatus === 400
          && /model\b.*not supported/i.test(firstErr.message || "")
          && activeModel !== "gemini-3.1-flash-tts-preview"
        ) {
          activeModel = "gemini-3.1-flash-tts-preview";
          usedModel = activeModel;
          activeCreds = {...creds, model: activeModel};
          fallbackNote = `Fell back to ${activeModel} after 400 unsupported model`;
          try {
            result = await runBackendSynthesis(cleanText, activeCreds, voiceName, activeModel, options);
          } catch (modelErr) {
            firstErr = modelErr;
          }
        }

        if (!result) {
          if (!canRetryWithoutPrompt(firstErr, activeCreds)) throw firstErr;

          if ((activeCreds.prompt || "").trim()) {
            try {
              result = await runBackendSynthesis(
                cleanText,
                {...activeCreds, prompt: ""},
                voiceName,
                activeModel,
                {...options, pitch: 1}
              );
              fallbackNote = "Retried without prompt after Vertex AI 400 filter";
            } catch (noPromptErr) {
              if (!canRetryWithoutPrompt(noPromptErr, activeCreds)) throw noPromptErr;
            }
          }

          if (!result && (activeCreds.backend === "portal" || activeCreds.backend === "cloud-tts")) {
            const fb = pickFallbackCloudVoice(languageCode);
            try {
              result = await runBackendSynthesis(
                cleanText,
                {...activeCreds, prompt: "", languageCode: fb.languageCode, disableModelName: true},
                fb.name,
                activeModel,
                {...options, pitch: 1}
              );
              usedVoice = fb.name;
              usedModel = "standard-fallback";
              fallbackNote = "Used Cloud Standard fallback after Vertex AI 400 filter";
            } catch (fbErr) {
              if (!isSafetyFilterError(fbErr)) throw fbErr;
            }
          }

          if (!result) {
            result = createSilentWavResult();
            fallbackNote = "Skipped chunk after Vertex AI 400 filter";
          }
        }
      }
      httpStatus = result.httpStatus;
      const durationMs = Date.now() - start;

      await recordTelemetry({
        status: "ok",
        backend: creds.backend,
        model: usedModel,
        voice: usedVoice,
        languageCode,
        prompt,
        textLength: cleanText.length,
        textPreview: cleanText.slice(0, 80),
        durationMs,
        httpStatus,
        mimeType: result.mimeType,
        audioBytes: result.audioBytes,
        error: fallbackNote
      });

      return {
        ...result,
        durationMs,
        backend: creds.backend,
        model: usedModel,
        voice: usedVoice
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      await recordTelemetry({
        status: "error",
        backend: creds.backend,
        model,
        voice: voiceName,
        languageCode,
        prompt,
        textLength: text.length,
        textPreview: text.slice(0, 80),
        durationMs,
        httpStatus: err.httpStatus || httpStatus,
        mimeType: null,
        audioBytes: 0,
        error: err.message || String(err)
      });
      throw err;
    }
  }

  async function callPortalTts(text, creds, voiceName, options) {
    const {gcpToken} = await getSettings(["gcpToken"]);
    if (!gcpToken) {
      throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
    }
    const url = "https://cxl-services.appspot.com/proxy?url=https://texttospeech.googleapis.com/v1beta1/text:synthesize&token=" + encodeURIComponent(gcpToken);
    const body = buildCloudTtsRequest(text, creds, voiceName, options);
    const res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
      }
      const msg = payload.error ? `${payload.error.code || res.status}: ${payload.error.message}` : `HTTP ${res.status}`;
      const err = new Error(`Portal TTS error (${msg})`);
      err.httpStatus = res.status;
      throw err;
    }
    if (!payload.audioContent) {
      const err = new Error("Portal TTS response missing audioContent");
      err.httpStatus = res.status;
      throw err;
    }
    return decodeCloudAudio(payload.audioContent, body.audioConfig.audioEncoding, res.status);
  }

  function decodeCloudAudio(audioContent, encoding, httpStatus) {
    const rawBytes = base64ToUint8Array(audioContent);
    let finalBytes = rawBytes;
    let mimeType = "audio/mpeg";
    if (encoding === "OGG_OPUS") {
      mimeType = "audio/ogg;codecs=opus";
    } else if (encoding === "LINEAR16") {
      mimeType = "audio/wav";
      finalBytes = hasRiffHeader(rawBytes)
        ? sanitizeWavBytes(rawBytes)
        : pcmToWavBytes(rawBytes, 24000, 1, 16);
    } else if (hasRiffHeader(rawBytes)) {
      mimeType = "audio/wav";
      finalBytes = sanitizeWavBytes(rawBytes);
    }
    const blob = new Blob([finalBytes], {type: mimeType});
    return {
      httpStatus,
      mimeType,
      audioBytes: finalBytes.byteLength,
      url: URL.createObjectURL(blob)
    };
  }

  async function callCloudTts(text, creds, voiceName, options) {
    const url = "https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=" + encodeURIComponent(creds.apiKey);
    const body = buildCloudTtsRequest(text, creds, voiceName, options);
    const res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = payload.error ? `${payload.error.code || res.status}: ${payload.error.message}` : `HTTP ${res.status}`;
      const err = new Error(`Cloud TTS error (${msg})`);
      err.httpStatus = res.status;
      throw err;
    }
    if (!payload.audioContent) {
      const err = new Error("Cloud TTS response missing audioContent");
      err.httpStatus = res.status;
      throw err;
    }

    return decodeCloudAudio(payload.audioContent, body.audioConfig.audioEncoding, res.status);
  }

  async function callGeminiApi(text, creds, voiceName, model, options) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`;
    const body = buildGeminiApiRequest(text, creds, voiceName, options);
    const res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = payload.error ? `${payload.error.code || res.status}: ${payload.error.message}` : `HTTP ${res.status}`;
      const err = new Error(`Gemini API error (${msg})`);
      err.httpStatus = res.status;
      throw err;
    }

    const parts = payload.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
    if (!audioPart) {
      const finishReason = payload.candidates?.[0]?.finishReason || "unknown";
      const err = new Error(`Gemini API returned no audio (finishReason: ${finishReason})`);
      err.httpStatus = res.status;
      throw err;
    }

    const srcMime = audioPart.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000";
    const rawBytes = base64ToUint8Array(audioPart.inlineData.data);
    let finalBytes = rawBytes;
    let outMime = srcMime;

    if (hasRiffHeader(rawBytes)) {
      finalBytes = sanitizeWavBytes(rawBytes);
      outMime = "audio/wav";
    } else if (/audio\/(l16|pcm)/i.test(srcMime) || !/wav|mpeg|mp3|ogg|opus/i.test(srcMime)) {
      const sampleRate = parsePcmSampleRate(srcMime);
      finalBytes = pcmToWavBytes(rawBytes, sampleRate, 1, 16);
      outMime = "audio/wav";
    }

    const blob = new Blob([finalBytes], {type: outMime});
    return {
      httpStatus: res.status,
      mimeType: outMime,
      audioBytes: finalBytes.byteLength,
      url: URL.createObjectURL(blob)
    };
  }

  function splitTranslateChunks(text, maxLen = 200) {
    const clean = String(text || "").trim();
    if (!clean) return [];
    if (clean.length <= maxLen) return [clean];
    const chunks = [];
    let rest = clean;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(" ", maxLen);
      if (cut < Math.floor(maxLen * 0.4)) cut = maxLen;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  async function callGoogleTranslateTts(text, creds, options) {
    const tl = String(creds.languageCode || options.lang || "en").trim() || "en";
    const parts = splitTranslateChunks(text, 200);
    const buffers = [];
    let totalBytes = 0;
    let lastStatus = 200;

    for (const part of parts) {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(tl)}&client=tw-ob&q=${encodeURIComponent(part)}`;
      const res = await fetch(url);
      lastStatus = res.status;
      if (!res.ok) {
        const err = new Error(`Google Translate TTS error (HTTP ${res.status})`);
        err.httpStatus = res.status;
        throw err;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) {
        const err = new Error("Google Translate TTS returned empty audio");
        err.httpStatus = res.status;
        throw err;
      }
      buffers.push(bytes);
      totalBytes += bytes.byteLength;
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(buf, offset);
      offset += buf.byteLength;
    }

    const blob = new Blob([merged], {type: "audio/mpeg"});
    return {
      httpStatus: lastStatus,
      mimeType: "audio/mpeg",
      audioBytes: merged.byteLength,
      url: URL.createObjectURL(blob)
    };
  }

  async function runOffscreenOrDirect(directFn, offscreenMethod, offscreenArgs, defaultMimeType, label) {
    let bytes;
    let mimeType = defaultMimeType;
    if (directFn) {
      const res = await directFn();
      bytes = res.bytes;
      mimeType = res.mimeType || mimeType;
    } else if (typeof brapi !== "undefined" && brapi.runtime && brapi.runtime.sendMessage) {
      if (typeof handlers !== "undefined" && typeof handlers.ensureOffscreen === "function") {
        await handlers.ensureOffscreen();
      } else if (typeof bgPageInvoke === "function") {
        await bgPageInvoke("ensureOffscreen");
      }
      const res = await brapi.runtime.sendMessage({
        dest: "offscreen",
        method: offscreenMethod,
        args: offscreenArgs
      });
      if (!res || !res.base64) {
        throw new Error((res && res.error) || `${label} offscreen synthesis failed.`);
      }
      bytes = base64ToUint8Array(res.base64);
      mimeType = res.mimeType || mimeType;
    } else {
      throw new Error(`${label} requires a browser window or offscreen document.`);
    }
    const blob = new Blob([bytes], {type: mimeType});
    return {
      httpStatus: 200,
      mimeType,
      audioBytes: bytes.byteLength,
      url: URL.createObjectURL(blob)
    };
  }

  async function callPhononWebGpu(text, creds, voiceName, options) {
    const rate = options && options.rate;
    const canDirect = typeof globalThis !== "undefined" && globalThis.phononBridge &&
      typeof navigator !== "undefined" && navigator.gpu;
    return runOffscreenOrDirect(
      canDirect ? () => globalThis.phononBridge.synthesize(text, voiceName, rate) : null,
      "synthesizePhonon",
      [text, voiceName, rate],
      "audio/wav",
      "Phonon WebGPU"
    );
  }

  async function callEdgeTts(text, creds, voiceName, options) {
    const rate = options && options.rate;
    const lang = creds.languageCode || (options && options.lang) || "en-gb";
    const canDirect = typeof globalThis !== "undefined" && globalThis.edgeTtsBridge &&
      typeof window !== "undefined";
    return runOffscreenOrDirect(
      canDirect ? () => globalThis.edgeTtsBridge.synthesize(text, voiceName, rate, lang) : null,
      "synthesizeEdgeTts",
      [text, voiceName, rate, lang],
      "audio/mpeg",
      "Edge TTS"
    );
  }

  function recordTelemetry(entry) {
    const fullEntry = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      timestamp: new Date().toISOString(),
      ...entry
    };
    telemetryQueue = telemetryQueue
      .then(async () => {
        const data = await getSettings(["geminiTelemetry"]);
        const list = Array.isArray(data.geminiTelemetry) ? data.geminiTelemetry : [];
        list.unshift(fullEntry);
        if (list.length > 100) list.length = 100;
        await updateSettings({geminiTelemetry: list});
      })
      .catch(err => console.error("Telemetry write failed", err));
    return telemetryQueue;
  }
}

function parsePcmSampleRate(mimeType) {
  const match = String(mimeType || "").match(/rate=(\d+)/i);
  return match ? Number(match[1]) : 24000;
}

function hasRiffHeader(bytes) {
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

function sanitizeWavBytes(rawBytes) {
  if (!hasRiffHeader(rawBytes) || rawBytes.byteLength < 44) return rawBytes;
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  let channels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataEnd = -1;
  let pos = 12;
  while (pos + 8 <= rawBytes.byteLength) {
    const c0 = rawBytes[pos];
    const c1 = rawBytes[pos + 1];
    const c2 = rawBytes[pos + 2];
    const c3 = rawBytes[pos + 3];
    const csize = view.getUint32(pos + 4, true);
    const chunkStart = pos + 8;
    const chunkEnd = Math.min(rawBytes.byteLength, chunkStart + csize);
    // "fmt "
    if (c0 === 0x66 && c1 === 0x6d && c2 === 0x74 && c3 === 0x20 && chunkEnd - chunkStart >= 16) {
      channels = view.getUint16(chunkStart + 2, true) || 1;
      sampleRate = view.getUint32(chunkStart + 4, true) || 24000;
      bitsPerSample = view.getUint16(chunkStart + 14, true) || 16;
    // "data"
    } else if (c0 === 0x64 && c1 === 0x61 && c2 === 0x74 && c3 === 0x61) {
      dataStart = chunkStart;
      dataEnd = chunkEnd;
      break;
    }
    const padded = csize + (csize & 1);
    const nextPos = chunkStart + padded;
    if (nextPos <= pos) break;
    pos = nextPos;
  }
  if (dataStart < 0) return rawBytes;
  const blockAlign = Math.max(1, channels * Math.floor(bitsPerSample / 8));
  const rawLen = dataEnd - dataStart;
  const alignedLen = rawLen - (rawLen % blockAlign);
  return pcmToWavBytes(rawBytes.subarray(dataStart, dataStart + alignedLen), sampleRate, channels, bitsPerSample);
}

function pcmToWavBytes(pcmBytes, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const dataLength = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Uint8Array(buffer);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

var geminiTtsEngine = new GeminiTtsEngine();
var dummyTtsEngine = new DummyTtsEngine();
