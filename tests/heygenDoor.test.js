'use strict';
/**
 * HeyGen voice door: GET /api/auth/heygen-balance/:token,
 * POST /api/auth/heygen-tts/:token and GET /api/auth/server-config/:token
 * are guarded by the MIGRATION_TOKEN pattern. The HeyGen API key stays in
 * the server env: the door calls the provider with it and returns only
 * the provider's public response (audio URL, duration, account JSON).
 * The config read reports key set/length only, never a key value.
 * The provider is a local stub reached through HEYGEN_API_BASE.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';
process.env.HEYGEN_API_KEY = 'test-heygen-key-not-real';
process.env.SPARK_API_KEY = 'test-spark-key-1234567890';

let server, base, stub, stubPort;
const stubSeen = [];

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      stubSeen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: raw });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v3/users/me') {
        res.end(JSON.stringify({ email: 'owner@example', wallet: { balance: 6.18, currency: 'USD' } }));
      } else if (req.url === '/v3/models/audio/tts') {
        res.end(JSON.stringify({ audio_url: 'https://stub.example/voice.wav', duration: 42.5 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'nope' }));
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  process.env.HEYGEN_API_BASE = `http://127.0.0.1:${stubPort}`;
  ({ server, base } = await startServer());
});
after(async () => { server.close(); stub.close(); });

const tok = () => process.env.MIGRATION_TOKEN;

test('heygen door rejects a wrong migration token on all three routes', async () => {
  const c = client(base);
  const b = await c.get('/api/auth/heygen-balance/wrong-token');
  assert.equal(b.status, 403);
  const t = await c.post('/api/auth/heygen-tts/wrong-token', { text: 'hello' });
  assert.equal(t.status, 403);
  const s = await c.get('/api/auth/server-config/wrong-token');
  assert.equal(s.status, 403);
});

test('balance passes the provider account JSON through', async () => {
  const c = client(base);
  const r = await c.get(`/api/auth/heygen-balance/${tok()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.provider.wallet.balance, 6.18);
  const seen = stubSeen.find((x) => x.url === '/v3/users/me');
  assert.equal(seen.key, 'test-heygen-key-not-real');
});

test('tts validates text, defaults voice and model, returns audio url', async () => {
  const c = client(base);
  const missing = await c.post(`/api/auth/heygen-tts/${tok()}`, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'text_required');
  const tooLong = await c.post(`/api/auth/heygen-tts/${tok()}`, { text: 'x'.repeat(5001) });
  assert.equal(tooLong.status, 400);

  const r = await c.post(`/api/auth/heygen-tts/${tok()}`, { text: 'Hello from the door.' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.audio_url, 'https://stub.example/voice.wav');
  assert.equal(r.json.duration, 42.5);
  const seen = stubSeen.filter((x) => x.url === '/v3/models/audio/tts').pop();
  const sent = JSON.parse(seen.body);
  assert.equal(sent.text, 'Hello from the door.');
  assert.equal(sent.model, 'heygen-voice-1');
  assert.equal(sent.voice_id, '0eed7849898e4362885098f714784920');
  assert.equal(seen.key, 'test-heygen-key-not-real');
});

test('server-config reports env and key set/length, never a key value', async () => {
  const c = client(base);
  const r = await c.get(`/api/auth/server-config/${tok()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.spark.api_key_set, true);
  assert.equal(r.json.spark.api_key_length, 'test-spark-key-1234567890'.length);
  assert.equal(r.json.spark.base_url_env, null);
  assert.equal(r.json.spark.effective_base_url, 'https://api.meta.ai/v1');
  assert.equal(r.json.spark.effective_model, 'muse-spark-1.3');
  assert.equal(r.json.heygen.api_key_set, true);
  const raw = JSON.stringify(r.json);
  assert.ok(!raw.includes('test-spark-key-1234567890'), 'spark key value leaked');
  assert.ok(!raw.includes('test-heygen-key-not-real'), 'heygen key value leaked');
});
