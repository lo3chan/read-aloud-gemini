const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

const engineSource = readFileSync(require.resolve('../js/tts-engines.js'), 'utf8');

function createEngineContext(creds, fetchImpl, initialTelemetry = [], extraGlobals = {}) {
  const storage = {
    geminiCreds: creds,
    geminiTelemetry: initialTelemetry
  };
  let createdBlob = null;
  const context = vm.createContext({
    assert,
    console,
    atob: b64 => Buffer.from(b64, 'base64').toString('binary'),
    Blob: class FakeBlob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts?.type || '';
        createdBlob = this;
      }
    },
    URL: {
      createObjectURL: () => 'blob:gemini-test',
      revokeObjectURL() {}
    },
    getSettings: async keys => {
      const out = {};
      for (const k of keys) out[k] = storage[k];
      return out;
    },
    updateSettings: async patch => {
      Object.assign(storage, patch);
    },
    fetch: fetchImpl,
    playAudio: promise => promise,
    setTimeout,
    clearTimeout,
    ...extraGlobals
  });
  vm.runInContext(engineSource, context);
  return {
    engine: context.geminiTtsEngine,
    storage,
    getCreatedBlob: () => createdBlob,
    context
  };
}

test('cloud-tts backend sends v1beta1 request with Scottish prompt, en-gb locale, and pitch from Options', async () => {
  let capturedRequest;
  const fakeMp3 = Buffer.from('ID3-fake-mp3').toString('base64');
  const {engine, storage} = createEngineContext(
    {
      backend: 'cloud-tts',
      apiKey: 'test-gcp-key',
      model: 'gemini-3.1-flash-tts-preview',
      languageCode: 'en-gb',
      audioEncoding: 'MP3',
      prompt: 'Speak with a natural, warm Scottish accent.'
    },
    async (url, options) => {
      capturedRequest = {url, ...options, body: JSON.parse(options.body)};
      return {
        ok: true,
        status: 200,
        json: async () => ({audioContent: fakeMp3})
      };
    }
  );

  const voices = await engine.getVoices();
  assert.equal(voices.length, 30);
  const achernar = voices.find(v => v.voiceName === 'Gemini Achernar');
  assert.ok(achernar);

  const url = await engine.speak('Movies, oh my gosh!', {voice: achernar, pitch: 1});
  assert.equal(url, 'blob:gemini-test');
  assert.equal(
    capturedRequest.url,
    'https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=test-gcp-key'
  );
  assert.deepEqual(capturedRequest.body, {
    audioConfig: {
      audioEncoding: 'MP3',
      pitch: 0,
      speakingRate: 1
    },
    input: {
      prompt: 'Speak with a natural, warm Scottish accent.',
      text: 'Movies, oh my gosh!'
    },
    voice: {
      languageCode: 'en-gb',
      modelName: 'gemini-3.1-flash-tts-preview',
      name: 'Achernar'
    }
  });
  assert.equal(storage.geminiTelemetry.length, 1);
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'cloud-tts');
  assert.equal(storage.geminiTelemetry[0].httpStatus, 200);
});

test('gemini-api backend wraps raw L16 PCM in a 44-byte WAV header', async () => {
  let capturedRequest;
  const rawPcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const {engine, getCreatedBlob} = createEngineContext(
    {
      backend: 'gemini-api',
      apiKey: 'test-ai-studio-key',
      model: 'gemini-3.1-flash-tts-preview',
      languageCode: 'en-gb',
      prompt: 'Speak with a natural, warm Scottish accent.'
    },
    async (url, options) => {
      capturedRequest = {url, ...options, body: JSON.parse(options.body)};
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: 'audio/L16;codec=pcm;rate=24000',
                  data: rawPcm.toString('base64')
                }
              }]
            }
          }]
        })
      };
    }
  );

  const voices = await engine.getVoices();
  const achernar = voices.find(v => v.voiceName === 'Gemini Achernar');
  await engine.speak('Aye, that works!', {voice: achernar});

  assert.equal(
    capturedRequest.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=test-ai-studio-key'
  );
  assert.deepEqual(capturedRequest.body, {
    contents: [{parts: [{text: 'Speak with a natural, warm Scottish accent.\n\nAye, that works!'}]}],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {voiceName: 'Achernar'}
        }
      }
    }
  });

  const blob = getCreatedBlob();
  assert.equal(blob.type, 'audio/wav');
  const wavBytes = blob.parts[0];
  assert.equal(wavBytes.byteLength, 48);
  assert.equal(Buffer.from(wavBytes.slice(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(wavBytes.slice(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(new DataView(wavBytes.buffer).getUint32(24, true), 24000);
});

test('records error telemetry and caps ring buffer at 100 entries', async () => {
  const existing = Array.from({length: 100}, (_, i) => ({id: 'old-' + i, status: 'ok'}));
  const {engine, storage} = createEngineContext(
    {
      backend: 'gemini-api',
      apiKey: 'bad-key',
      model: 'gemini-3.1-flash-tts-preview',
      prompt: ''
    },
    async () => ({
      ok: false,
      status: 429,
      json: async () => ({error: {code: 429, message: 'Quota exceeded'}})
    }),
    existing
  );

  const voices = await engine.getVoices();
  await assert.rejects(
    () => engine.speak('Test rate limit', {voice: voices[0]}),
    /429: Quota exceeded/
  );

  assert.equal(storage.geminiTelemetry.length, 100);
  assert.equal(storage.geminiTelemetry[0].status, 'error');
  assert.equal(storage.geminiTelemetry[0].httpStatus, 429);
  assert.match(storage.geminiTelemetry[0].error, /Quota exceeded/);
});

test('portal backend retries without prompt and falls back to Standard voice on Vertex AI 400 safety block', async () => {
  const requests = [];
  const {engine, storage} = createEngineContext(
    {
      backend: 'portal',
      model: 'gemini-3.1-flash-tts-preview',
      languageCode: 'en-gb',
      prompt: 'Speak with a natural, warm Scottish accent.'
    },
    async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({url, body});
      if (body.voice.modelName) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: 400,
              message: "Cloud Text-to-Speech could not generate audio because the input text or prompt violates Vertex AI's usage guidelines. Support codes: 54702341"
            }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({audioContent: Buffer.from('ok-mp3').toString('base64')})
      };
    }
  );
  storage.gcpToken = 'portal-tok';

  const voices = await engine.getVoices();
  await engine.speak('Reader Mode.\n\n', {voice: voices[0]});

  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.input.text, 'Reader Mode.');
  assert.equal(requests[0].body.input.prompt, 'Speak with a natural, warm Scottish accent.');
  assert.equal(requests[1].body.input.prompt, undefined);
  assert.equal(requests[2].body.voice.modelName, undefined);
  assert.equal(requests[2].body.voice.name, 'en-GB-Standard-A');
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].voice, 'en-GB-Standard-A');
});

test('runBackendSynthesis performs single transient retry on 429, 502, 503, or network error', async () => {
  let callCount = 0;
  const {engine, storage} = createEngineContext(
    {
      backend: 'gemini-api',
      apiKey: 'test-key',
      model: 'gemini-3.8-flash-lite-tts',
      prompt: ''
    },
    async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service Temporarily Unavailable'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: 'audio/L16;rate=24000',
                  data: Buffer.from([0x10, 0x20, 0x30, 0x40]).toString('base64')
                }
              }]
            }
          }]
        })
      };
    }
  );

  const voices = await engine.getVoices();
  const url = await engine.speak('Retry please', {voice: voices[0]});
  assert.equal(url, 'blob:gemini-test');
  assert.equal(callCount, 2);
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].httpStatus, 200);
});

test('portal and cloud-tts backends fall back to gemini-3.1-flash-tts-preview on 400 unsupported model', async () => {
  for (const backendCase of [
    {backend: 'portal', gcpToken: 'portal-token'},
    {backend: 'cloud-tts', apiKey: 'cloud-key'}
  ]) {
    const requests = [];
    const fakeWav = Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer;
    const fakeWavBase64 = Buffer.from(fakeWav).toString('base64');
    const {engine, storage} = createEngineContext(
      {
        backend: backendCase.backend,
        apiKey: backendCase.apiKey || '',
        model: 'gemini-3.8-flash-lite-tts',
        prompt: 'Speak warmly'
      },
      async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (body.voice && body.voice.modelName === 'gemini-3.8-flash-lite-tts') {
          const payload = {error: {code: 400, message: "The model 'gemini-3.8-flash-lite-tts' is not supported."}};
          return {
            ok: false,
            status: 400,
            json: async () => payload,
            text: async () => JSON.stringify(payload)
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({audioContent: fakeWavBase64})
        };
      }
    );
    if (backendCase.gcpToken) storage.gcpToken = backendCase.gcpToken;

    const voices = await engine.getVoices();
    const url = await engine.speak('Fallback test text', {voice: voices[0]});
    assert.equal(url, 'blob:gemini-test');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].voice.modelName, 'gemini-3.8-flash-lite-tts');
    assert.equal(requests[1].voice.modelName, 'gemini-3.1-flash-tts-preview');
    assert.equal(storage.geminiTelemetry[0].status, 'ok');
    assert.equal(storage.geminiTelemetry[0].model, 'gemini-3.1-flash-tts-preview');
    assert.ok(storage.geminiTelemetry[0].error.includes('gemini-3.1-flash-tts-preview'));
  }
});

test('strips trailing C2PA RIFF chunks from audio/wav responses in gemini-api backend', async () => {
  const pcmSamples = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  const c2paPayload = Buffer.alloc(128, 0xaa);
  const riffSize = 4 + (8 + 16) + (8 + pcmSamples.length) + (8 + c2paPayload.length);
  const wavWithC2pa = Buffer.alloc(8 + riffSize);
  let offset = 0;
  wavWithC2pa.write('RIFF', offset); offset += 4;
  wavWithC2pa.writeUInt32LE(riffSize, offset); offset += 4;
  wavWithC2pa.write('WAVE', offset); offset += 4;
  wavWithC2pa.write('fmt ', offset); offset += 4;
  wavWithC2pa.writeUInt32LE(16, offset); offset += 4;
  wavWithC2pa.writeUInt16LE(1, offset); offset += 2;
  wavWithC2pa.writeUInt16LE(1, offset); offset += 2;
  wavWithC2pa.writeUInt32LE(24000, offset); offset += 4;
  wavWithC2pa.writeUInt32LE(48000, offset); offset += 4;
  wavWithC2pa.writeUInt16LE(2, offset); offset += 2;
  wavWithC2pa.writeUInt16LE(16, offset); offset += 2;
  wavWithC2pa.write('data', offset); offset += 4;
  wavWithC2pa.writeUInt32LE(pcmSamples.length, offset); offset += 4;
  pcmSamples.copy(wavWithC2pa, offset); offset += pcmSamples.length;
  wavWithC2pa.write('C2PA', offset); offset += 4;
  wavWithC2pa.writeUInt32LE(c2paPayload.length, offset); offset += 4;
  c2paPayload.copy(wavWithC2pa, offset);

  // 1. gemini-api returning audio/wav with C2PA
  {
    const {engine, getCreatedBlob} = createEngineContext(
      {backend: 'gemini-api', apiKey: 'test-key', model: 'gemini-3.8-flash-lite-tts', prompt: ''},
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {parts: [{inlineData: {mimeType: 'audio/wav', data: wavWithC2pa.toString('base64')}}]}
          }]
        })
      })
    );
    const voices = await engine.getVoices();
    await engine.speak('Strip C2PA test', {voice: voices[0]});
    const out = Buffer.from(getCreatedBlob().parts[0]);
    assert.equal(getCreatedBlob().type, 'audio/wav');
    assert.equal(out.length, 44 + pcmSamples.length);
    assert.deepEqual(out.subarray(44), pcmSamples);
  }
});

test('google-translate backend works without API key and splits text into <=200 char requests', async () => {
  const urls = [];
  const {engine, storage, getCreatedBlob} = createEngineContext(
    {
      backend: 'google-translate',
      languageCode: 'en-gb',
      apiKey: ''
    },
    async (url) => {
      urls.push(url);
      const fakeMp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x44]);
      return {
        ok: true,
        status: 200,
        headers: {get: () => 'audio/mpeg'},
        arrayBuffer: async () => fakeMp3.buffer
      };
    }
  );

  const voices = await engine.getVoices();
  const longText = 'word '.repeat(60).trim(); // 299 chars -> 2 chunks <= 200 chars
  await engine.speak(longText, {voice: voices[0]});

  assert.equal(urls.length, 2);
  for (const u of urls) {
    const parsed = new URL(u);
    assert.equal(parsed.origin + parsed.pathname, 'https://translate.google.com/translate_tts');
    assert.equal(parsed.searchParams.get('tl'), 'en-gb');
    assert.ok(parsed.searchParams.get('q').length <= 200);
  }
  assert.equal(getCreatedBlob().type, 'audio/mpeg');
  assert.equal(getCreatedBlob().parts[0].byteLength, 8);
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'google-translate');
});

test('phonon-webgpu backend routes to offscreen synthesizePhonon when navigator.gpu is absent', async () => {
  let offscreenEnsured = false;
  const sentMessages = [];
  const {engine, storage, context, getCreatedBlob} = createEngineContext(
    {
      backend: 'phonon-webgpu',
      languageCode: 'en-gb',
      apiKey: ''
    },
    async () => {
      throw new Error('fetch should not be called for phonon-webgpu');
    }
  );

  context.handlers = {
    ensureOffscreen: async () => {
      offscreenEnsured = true;
    }
  };
  context.brapi = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return {
          base64: Buffer.from('RIFFtestWAV').toString('base64'),
          mimeType: 'audio/wav'
        };
      }
    }
  };

  const result = await engine.test(storage.geminiCreds, 'Hello Phonon WebGPU.', 'Achernar');
  assert.equal(offscreenEnsured, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].dest, 'offscreen');
  assert.equal(sentMessages[0].method, 'synthesizePhonon');
  assert.equal(sentMessages[0].args[0], 'Hello Phonon WebGPU.');
  assert.equal(sentMessages[0].args[1], 'Achernar');
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(getCreatedBlob().type, 'audio/wav');
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'phonon-webgpu');
});

test('edgeTtsBridge.generateSecMsGecV2 matches reference v2 token format', () => {
  const edgeBridgeSource = readFileSync(require.resolve('../js/edge-tts-bridge.js'), 'utf8');
  const ctx = vm.createContext({
    crypto: require('node:crypto').webcrypto,
    btoa: str => Buffer.from(str, 'binary').toString('base64')
  });
  ctx.globalThis = ctx;
  vm.runInContext(edgeBridgeSource, ctx);

  assert.equal(
    ctx.edgeTtsBridge.generateSecMsGecV2(1794722000),
    '7ABC81844F44D581-142F05E3BB83A929060B0DD200224F45A83D9F12D80866842DC163270DC896F2'
  );
  assert.equal(ctx.edgeTtsBridge.mapEdgeVoice('Achernar', 'en-gb'), 'en-GB-SoniaNeural');
  assert.equal(ctx.edgeTtsBridge.mapEdgeVoice('Charon', 'en-gb'), 'en-GB-RyanNeural');
  assert.equal(ctx.edgeTtsBridge.mapEdgeVoice('en-US-AriaNeural', 'en-gb'), 'en-US-AriaNeural');
});

test('edge-tts backend routes to offscreen synthesizeEdgeTts when window is absent', async () => {
  let offscreenEnsured = false;
  const sentMessages = [];
  const {engine, storage, context, getCreatedBlob} = createEngineContext(
    {
      backend: 'edge-tts',
      languageCode: 'en-gb',
      apiKey: ''
    },
    async () => {
      throw new Error('fetch should not be called for edge-tts');
    }
  );

  context.handlers = {
    ensureOffscreen: async () => {
      offscreenEnsured = true;
    }
  };
  context.brapi = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return {
          base64: Buffer.from('ID3fakeMP3').toString('base64'),
          mimeType: 'audio/mpeg'
        };
      }
    }
  };

  const result = await engine.test(storage.geminiCreds, 'Hello direct Edge TTS.', 'Achernar');
  assert.equal(offscreenEnsured, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].dest, 'offscreen');
  assert.equal(sentMessages[0].method, 'synthesizeEdgeTts');
  assert.equal(sentMessages[0].args[0], 'Hello direct Edge TTS.');
  assert.equal(sentMessages[0].args[1], 'Achernar');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(getCreatedBlob().type, 'audio/mpeg');
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'edge-tts');
});

test('getVoicesForBackend returns backend-specific voice catalogs', async () => {
  const {engine} = createEngineContext(
    {backend: 'gemini-api', languageCode: 'en-gb'},
    async () => ({}),
    [],
    {
      brapi: {
        tts: {
          getVoices: cb => cb([
            {voiceName: 'OS British Voice', lang: 'en-GB', remote: false}
          ]),
          speak() {},
          stop() {},
          pause() {},
          resume() {},
          isSpeaking() {}
        }
      }
    }
  );

  const geminiVoices = await engine.getVoicesForBackend('gemini-api', 'en-gb');
  assert.equal(geminiVoices[0].voiceName, 'Gemini Achernar');

  const edgeVoices = await engine.getVoicesForBackend('edge-tts', 'en-gb');
  assert.ok(edgeVoices.some(v => v.voiceName === 'en-GB-SoniaNeural'));
  assert.ok(!edgeVoices.some(v => v.voiceName === 'ja-JP-NanamiNeural'));

  const phononVoices = await engine.getVoicesForBackend('phonon-webgpu', 'en-gb');
  assert.ok(phononVoices.some(v => v.voiceName === 'Delia'));
  assert.ok(phononVoices.some(v => v.voiceName === 'Easton'));

  const translateVoices = await engine.getVoicesForBackend('google-translate', 'fr-fr');
  assert.equal(translateVoices.length, 1);
  assert.equal(translateVoices[0].geminiVoice, 'GoogleTranslate');

  const nativeVoices = await engine.getVoicesForBackend('native', 'en-gb');
  assert.equal(nativeVoices.length, 1);
  assert.equal(nativeVoices[0].voiceName, 'OS British Voice');
  assert.equal(nativeVoices[0].isNative, true);
});

test('native backend tests BrowserTtsEngine without API key and records telemetry', async () => {
  const spoken = [];
  const {engine, storage} = createEngineContext(
    {backend: 'native', languageCode: 'en-GB', apiKey: ''},
    async () => {
      throw new Error('fetch should not be called for native backend');
    },
    [],
    {
      brapi: {
        tts: {
          getVoices: cb => cb([{voiceName: 'OS Voice 1', lang: 'en-GB'}]),
          speak: (text, opts) => {
            spoken.push({text, opts});
            opts.onEvent({type: 'start', charIndex: 0});
            opts.onEvent({type: 'end', charIndex: text.length});
          },
          stop() {},
          pause() {},
          resume() {},
          isSpeaking() {}
        }
      }
    }
  );

  const res = await engine.test(storage.geminiCreds, 'Native voice check.', 'OS Voice 1');
  assert.equal(res.httpStatus, 200);
  assert.equal(res.mimeType, 'native/tts');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Native voice check.');
  assert.equal(spoken[0].opts.voiceName, 'OS Voice 1');
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'native');
});
