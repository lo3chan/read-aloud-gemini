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
