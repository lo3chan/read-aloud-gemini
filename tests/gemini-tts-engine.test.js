const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

const engineSource = readFileSync(require.resolve('../js/tts-engines.js'), 'utf8');

function createEngineContext(creds, fetchImpl, initialTelemetry = []) {
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
  });
  vm.runInContext(engineSource, context);
  return {
    engine: context.geminiTtsEngine,
    storage,
    getCreatedBlob: () => createdBlob
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

test('custom backend sends /v1/audio/speech with optional Bearer token, instructions, and returns audio/wav blob', async () => {
  const requests = [];
  const fakeWav = Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer;
  const {engine, storage, getCreatedBlob} = createEngineContext(
    {
      backend: 'custom',
      customUrl: 'https://tts.example.com',
      apiKey: 'test_bearer_token',
      model: 'gemini-3.8-flash-lite-tts',
      audioEncoding: 'LINEAR16',
      prompt: 'Speak warmly.'
    },
    async (url, options) => {
      requests.push({
        url,
        headers: options.headers,
        body: JSON.parse(options.body)
      });
      return {
        ok: true,
        status: 200,
        headers: {get: () => 'audio/wav'},
        arrayBuffer: async () => fakeWav
      };
    }
  );

  const voices = await engine.getVoices();
  const achernar = voices.find(v => v.voiceName === 'Gemini Achernar');
  const url = await engine.speak('Hello custom backend!', {voice: achernar});

  assert.equal(url, 'blob:gemini-test');
  assert.equal(getCreatedBlob().type, 'audio/wav');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://tts.example.com/v1/audio/speech');
  assert.equal(requests[0].headers.Authorization, 'Bearer test_bearer_token');
  assert.deepEqual(requests[0].body, {
    model: 'gemini-3.8-flash-lite-tts',
    input: 'Hello custom backend!',
    voice: 'Achernar',
    instructions: 'Speak warmly.',
    response_format: 'wav'
  });
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.equal(storage.geminiTelemetry[0].backend, 'custom');
  assert.equal(storage.geminiTelemetry[0].mimeType, 'audio/wav');

  // Keyless request (e.g., local server or internal IP) omits Authorization header and defaults to mp3
  storage.geminiCreds = {
    backend: 'custom',
    customUrl: 'https://local-tts.example.com/v1/audio/speech',
    apiKey: '',
    model: 'gemini-3.8-flash-lite-tts',
    audioEncoding: 'MP3',
    prompt: ''
  };
  await engine.speak('Keyless test!', {voice: achernar});
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://local-tts.example.com/v1/audio/speech');
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[1].body.response_format, 'mp3');
});

test('buildCustomSpeechRequest maps encodings to response_format and defaults model to gemini-3.8-flash-lite-tts', () => {
  const {engine} = createEngineContext({}, async () => ({}));
  assert.equal(engine.defaultConfig.model, 'gemini-3.8-flash-lite-tts');

  // Default / MP3 -> mp3
  const reqDefault = engine.buildCustomSpeechRequest('Test text', {customUrl: 'https://tts.example.com'}, 'Achernar');
  assert.equal(reqDefault.response_format, 'mp3');
  assert.equal(reqDefault.model, 'gemini-3.8-flash-lite-tts');

  const reqMp3 = engine.buildCustomSpeechRequest('Test text', {audioEncoding: 'MP3'}, 'Achernar');
  assert.equal(reqMp3.response_format, 'mp3');

  // OGG_OPUS -> opus
  const reqOpus = engine.buildCustomSpeechRequest('Test text', {audioEncoding: 'OGG_OPUS'}, 'Achernar');
  assert.equal(reqOpus.response_format, 'opus');

  // LINEAR16 -> wav
  const reqWav = engine.buildCustomSpeechRequest('Test text', {audioEncoding: 'LINEAR16'}, 'Achernar');
  assert.equal(reqWav.response_format, 'wav');
});

test('runBackendSynthesis performs single transient retry on 429, 502, 503, or network error', async () => {
  let callCount = 0;
  const fakeWav = Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer;
  const {engine, storage} = createEngineContext(
    {
      backend: 'custom',
      customUrl: 'https://tts.example.com',
      audioEncoding: 'LINEAR16'
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
        headers: {get: () => 'audio/wav'},
        arrayBuffer: async () => fakeWav
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

test('custom backend retries without prompt on 400, 502, or 503 and logs fallback telemetry', async () => {
  const requests = [];
  const fakeWav = Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer;
  const {engine, storage} = createEngineContext(
    {
      backend: 'custom',
      customUrl: 'https://tts.example.com',
      audioEncoding: 'LINEAR16',
      prompt: 'Special accent'
    },
    async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.instructions) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({error: {message: 'Instructions not supported'}})
        };
      }
      return {
        ok: true,
        status: 200,
        headers: {get: () => 'audio/wav'},
        arrayBuffer: async () => fakeWav
      };
    }
  );

  const voices = await engine.getVoices();
  const url = await engine.speak('Test prompt fallback', {voice: voices[0]});
  assert.equal(url, 'blob:gemini-test');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].instructions, 'Special accent');
  assert.equal(requests[1].instructions, undefined);
  assert.equal(storage.geminiTelemetry[0].status, 'ok');
  assert.ok(storage.geminiTelemetry[0].error.includes('Retried without prompt'));
});
