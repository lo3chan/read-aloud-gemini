(function(global) {
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const CHROMIUM_FULL_VERSION = "143.0.3650.75";
  const WIN_EPOCH_SECS = 11644473600;
  const DNR_RULE_ID = 9101;

  const SHA256_INITIAL = new Uint32Array([
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
  ]);
  const SHA256_STATE = new Uint32Array([
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
    0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2
  ]);
  const SHA256_SCHEDULE = new Uint32Array([
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
    0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564
  ]);
  const SHA256_ROUND_CONSTANTS = new Uint32Array([
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
  ]);
  const SHA256_ADJUSTMENT = 0xC9DC06A7;
  const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
  const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

  const CS64_COEFFICIENTS = [
    [0xE82E91B1, 0xB32700D0],
    [0x44DE24C6, 0x88DFF51D],
    [0x3BEB65BC, 0x29514038],
    [0xC89C5933, 0xB328CBDF],
    [0x8D1EC211, 0xD405B4D5],
    [0x314EF5D5, 0x26E55F3C],
    [0xE92491B1, 0x607801C6],
    [0xF0A5B9D5, 0x82B2C1FB],
    [0x06064CF3, 0xFA51A3DA],
    [0xDA79FA60, 0x207CC464],
    [0xBED20560, 0x3C3C74F3],
    [0x89F9C9F8, 0xD2D14B61],
    [0x35FA38C6, 0xBB04A2C1],
    [0xCB49E3C6, 0xC5626167]
  ];
  const CS64_FACTOR = 0x82893933;
  const CS64_ADJUSTMENT0 = 0xF2F90B1A;
  const CS64_ADJUSTMENT1 = 0x0B1A0000;

  const MALE_VOICE_HINTS = new Set([
    "charon", "fenrir", "puck", "orus", "alnilam", "algenib", "algieba",
    "enceladus", "iapetus", "rasalgethi", "sadachbia", "sadaltager",
    "schedar", "umbriel", "zubenelgenubi", "onyx", "echo", "ryan", "guy", "thomas"
  ]);

  function rotr(v, n) {
    return ((v >>> n) | (v << (32 - n))) >>> 0;
  }

  function rotl16(v) {
    return (((v << 16) | (v >>> 16)) >>> 0);
  }

  function sigma0(v) {
    return (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
  }

  function sigma1(v) {
    return (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;
  }

  function sha256Rounds(state, words, firstRound) {
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = firstRound; i < 64; i++) {
      const k = (firstRound === 14 && i === 14) ? SHA256_ADJUSTMENT : SHA256_ROUND_CONSTANTS[i];
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const t1 = (h + s1 + ch + k + words[i]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    return new Uint32Array([a, b, c, d, e, f, g, h]);
  }

  function expandSha256Schedule(words, firstWord) {
    for (let i = firstWord; i < 64; i++) {
      words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
    }
  }

  function tokenSha256Digest(data) {
    const initWords = new Uint32Array(64);
    initWords[14] = ((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0;
    initWords[15] = ((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0;
    for (let i = 16; i < 30; i++) {
      let val = SHA256_SCHEDULE[i - 16];
      if (i - 2 >= 14) {
        const s1 = sigma1(initWords[i - 2]);
        val = (val + (i === 16 ? ((s1 ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0) : s1)) >>> 0;
      }
      if (i - 7 >= 14) {
        val = (val + initWords[i - 7]) >>> 0;
      }
      if (i - 15 >= 14) {
        const s0 = sigma0(initWords[i - 15]);
        val = (val + (i === 29 ? ((s0 ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0) : s0)) >>> 0;
      }
      initWords[i] = val;
    }
    initWords[30] = (
      sigma1(initWords[28]) +
      initWords[23] +
      sigma0(initWords[15]) +
      initWords[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]
    ) >>> 0;
    expandSha256Schedule(initWords, 31);
    const workingInit = sha256Rounds(SHA256_STATE, initWords, 14);
    let state = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      state[i] = (SHA256_INITIAL[i] + workingInit[i]) >>> 0;
    }

    const totalLen = 57 + data.length;
    const remLen = data.length - 7;
    const padZeros = (55 - (totalLen % 64) + 64) % 64;
    const padded = new Uint8Array(remLen + 1 + padZeros + 8);
    padded.set(data.subarray(7), 0);
    padded[remLen] = 0x80;
    const bitLen = BigInt(totalLen) * 8n;
    const dv = new DataView(padded.buffer);
    dv.setBigUint64(padded.length - 8, bitLen, false);

    for (let offset = 0; offset < padded.length; offset += 64) {
      const block = new Uint32Array(64);
      for (let i = 0; i < 16; i++) {
        block[i] = dv.getUint32(offset + i * 4, false);
      }
      expandSha256Schedule(block, 16);
      const working = sha256Rounds(state, block, 0);
      for (let i = 0; i < 8; i++) {
        state[i] = (state[i] + working[i]) >>> 0;
      }
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, state[i], false);
    }
    return out;
  }

  function cs64Digest(data, digest) {
    const dv = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    const keyA = (dv.getUint32(0, true) | 1) >>> 0;
    const keyB = (dv.getUint32(4, true) | 1) >>> 0;
    const factors = [Math.imul(keyA, CS64_FACTOR) >>> 0, Math.imul(keyB, CS64_FACTOR) >>> 0];

    const terms = [];
    const offsets = [];
    for (let i = 0; i < CS64_COEFFICIENTS.length; i++) {
      const [coeff, off] = CS64_COEFFICIENTS[i];
      terms.push(Math.imul(coeff, factors[i % 2]) >>> 0);
      offsets.push(off >>> 0);
    }

    const prefixedLen = 1 + data.length;
    const padLen = (4 - (prefixedLen % 4)) % 4;
    let wordCount = (prefixedLen + padLen) / 4;
    if (wordCount % 2 !== 0) wordCount += 1;
    const prefixed = new Uint8Array(wordCount * 4);
    prefixed[0] = 0;
    prefixed.set(data, 1);
    const pView = new DataView(prefixed.buffer);

    for (let idx = 0; idx < wordCount; idx++) {
      const word = pView.getUint32(idx * 4, true);
      let term = Math.imul(word, idx % 2 === 0 ? keyA : keyB) >>> 0;
      let offset = Math.imul(rotl16(word), idx % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0;
      if (idx === 0) {
        term = (term + Math.imul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
        offset = (offset + CS64_ADJUSTMENT1) >>> 0;
      }
      terms.push(term);
      offsets.push(offset);
    }

    let swapAcc = 0;
    let swapLast = 0;
    let state = 0;
    let acc = 0;
    for (let i = 0; i < terms.length; i += 2) {
      const x = terms[i];
      const y = terms[i + 1];
      const ox = offsets[i];
      const oy = offsets[i + 1];

      let t = rotl16((ox + x) >>> 0);
      let q = Math.imul(t, 0x76F50F34) >>> 0;
      swapAcc = (swapAcc + ((Math.imul(rotl16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;

      t = rotl16((oy + y) >>> 0);
      q = Math.imul(t, 0x1881CE3C) >>> 0;
      swapLast = (Math.imul(rotl16(q), 0x35BD1EC9) + q) >>> 0;
      swapAcc = (swapAcc + swapLast) >>> 0;

      state = (Math.imul(state, keyA) + x) >>> 0;
      state = Math.imul(rotl16(state), 0xCF98B111) >>> 0;
      state = Math.imul(rotl16(state), 0x87085B9F) >>> 0;
      state = Math.imul(rotl16(state), 0x12CEB96D) >>> 0;
      state = Math.imul(rotl16(state), 0x257E1D83) >>> 0;
      acc = (acc + state) >>> 0;

      t = (Math.imul(state, keyB) + y) >>> 0;
      t = Math.imul(rotl16(t), 0xA27416F5) >>> 0;
      t = Math.imul(rotl16(t), 0xD38396FF) >>> 0;
      state = Math.imul(rotl16(Math.imul(rotl16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
      acc = (acc + state) >>> 0;
    }

    return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
  }

  function generateSecMsGecV2(unixSecs) {
    const secs = unixSecs != null ? Math.floor(Number(unixSecs)) : Math.floor(Date.now() / 1000);
    let ticks = secs + WIN_EPOCH_SECS;
    ticks -= ticks % 300;
    const ticks100ns = BigInt(ticks) * 10000000n;
    const inputStr = ticks100ns.toString() + TRUSTED_CLIENT_TOKEN;
    const data = new Uint8Array(inputStr.length);
    for (let i = 0; i < inputStr.length; i++) {
      data[i] = inputStr.charCodeAt(i);
    }
    const digest = tokenSha256Digest(data);
    const [csA, csB] = cs64Digest(data, digest);
    const csBytes = new Uint8Array(8);
    const csView = new DataView(csBytes.buffer);
    csView.setUint32(0, csA, true);
    csView.setUint32(4, csB, true);
    const toHex = (arr) => Array.from(arr, b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
    return `${toHex(csBytes)}-${toHex(digest)}`;
  }

  function randomHex32() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  }

  function escapeXml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function mapEdgeVoice(voiceName, languageCode) {
    const raw = String(voiceName || "").trim().replace(/^Gemini\s+/i, "");
    if (/^[a-z]{2,3}-[A-Z]{2}-.+Neural$/i.test(raw)) {
      return raw;
    }
    const lower = raw.toLowerCase();
    const lang = String(languageCode || "en-gb").toLowerCase();
    const isMale = MALE_VOICE_HINTS.has(lower);
    if (lang.startsWith("en-us")) {
      return isMale ? "en-US-GuyNeural" : "en-US-JennyNeural";
    }
    if (lang.startsWith("en-au")) {
      return isMale ? "en-AU-WilliamNeural" : "en-AU-NatashaNeural";
    }
    if (lang.startsWith("en-in")) {
      return isMale ? "en-IN-PrabhatNeural" : "en-IN-NeerjaNeural";
    }
    return isMale ? "en-GB-RyanNeural" : "en-GB-SoniaNeural";
  }

  function formatRatePercent(speed) {
    const s = Number.isFinite(Number(speed)) && Number(speed) > 0
      ? Math.max(0.5, Math.min(2.0, Number(speed)))
      : 1.0;
    const pct = Math.round((s - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }

  async function ensureDnrRule(muid) {
    const dnr =
      (global.brapi && global.brapi.declarativeNetRequest) ||
      (global.chrome && global.chrome.declarativeNetRequest) ||
      (global.browser && global.browser.declarativeNetRequest);
    if (!dnr || typeof dnr.updateDynamicRules !== "function") {
      throw new Error("declarativeNetRequest API is required for direct Edge TTS.");
    }
    await dnr.updateDynamicRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [{
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Origin",
              operation: "set",
              value: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            },
            {
              header: "User-Agent",
              operation: "set",
              value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
            },
            {
              header: "Cookie",
              operation: "set",
              value: `muid=${muid};`
            }
          ]
        },
        condition: {
          urlFilter: "||speech.platform.bing.com/",
          resourceTypes: ["websocket"]
        }
      }]
    });
  }

  function uint8ToBase64(bytes) {
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }

  async function synthesize(text, voiceName, speed, languageCode) {
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      throw new Error("Empty text for Edge TTS synthesis.");
    }
    const muid = randomHex32();
    await ensureDnrRule(muid);

    const gec = generateSecMsGecV2();
    const connId = randomHex32();
    const reqId = randomHex32();
    const edgeVoice = mapEdgeVoice(voiceName, languageCode);
    const xmlLang = edgeVoice.split("-").slice(0, 2).join("-") || "en-GB";
    const rate = formatRatePercent(speed);
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=2-${CHROMIUM_FULL_VERSION}&ConnectionId=${connId}`;

    const chunks = [];
    let totalBytes = 0;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        done(new Error("Edge TTS WebSocket timed out."));
      }, 30000);

      ws.onopen = () => {
        const ts = new Date().toISOString();
        ws.send(
          `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
        );
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'><voice name='${edgeVoice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeXml(cleanText)}</prosody></voice></speak>`;
        ws.send(
          `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`
        );
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.includes("Path:turn.end")) {
            try { ws.close(); } catch (_) {}
            done();
          }
        } else if (ev.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(ev.data);
          if (u8.length >= 2) {
            const hdrLen = (u8[0] << 8) | u8[1];
            const audioStart = 2 + hdrLen;
            if (audioStart < u8.length) {
              const slice = u8.subarray(audioStart);
              chunks.push(slice);
              totalBytes += slice.length;
            }
          }
        }
      };

      ws.onerror = () => done(new Error("Edge TTS WebSocket connection failed."));
      ws.onclose = (ev) => {
        if (!settled) {
          if (totalBytes > 0) done();
          else done(new Error(`Edge TTS WebSocket closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})`));
        }
      };
    });

    if (totalBytes === 0) {
      throw new Error("Edge TTS returned empty audio.");
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return { bytes: merged, mimeType: "audio/mpeg" };
  }

  global.edgeTtsBridge = {
    generateSecMsGecV2,
    mapEdgeVoice,
    synthesize,
    uint8ToBase64
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
