'use strict';
/**
 * Assistant chat on the house Spark slot (2026-11-22): the Grok key
 * ("MannaScribe", xAI, SPARK_* env) was installed in Render on
 * 2026-10-29 and powered Scribe's ANALYSIS, but the instructor chat
 * never called the Spark client, so the owner got the keyword insight
 * engine while a real model sat in the building. These tests pin the
 * wiring: with a configured Spark client, chat answers through it,
 * grounded in the tenant context (drafts included), with history
 * folded in; on any Spark failure it falls back to the insight engine
 * instead of inventing an answer.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv } = require('./helpers');

setupTestEnv();

const assistant = require('../src/lib/assistant');

function fakeTdb() {
  return {
    emailSnapshots: () => [{ window_key: 'all', sent: 10, opens: 2, clicks: 1 }],
    goals: () => [],
    funnels: () => [],
    socialAccounts: () => [],
    listSites: () => [],
    listScribeDrafts: () => [
      { title: 'Film Manna Promo Video', draft_type: 'video_brief', created_at: '2026-11-20T21:42:36.006Z' },
    ],
  };
}

test('chat answers through the Spark slot when configured, grounded in tenant data', async () => {
  let captured = null;
  const client = {
    isConfigured: () => true,
    chatCompletion: async (args) => { captured = args; return 'Your drafts wait under this chat.'; },
  };
  const r = await assistant.chat('where are my scribe drafts', fakeTdb(), [], client);
  assert.equal(r.provider, 'spark');
  assert.equal(r.reply, 'Your drafts wait under this chat.');
  assert.ok(captured, 'spark client was called');
  assert.ok(captured.system.includes('scribeDrafts'), 'context carries the drafts');
  assert.ok(captured.system.includes('Film Manna Promo Video'), 'draft title is in the grounding data');
  assert.ok(captured.user.includes('where are my scribe drafts'), 'question reaches the model');
});

test('chat folds history into the Spark call so follow-ups keep meaning', async () => {
  let captured = null;
  const client = {
    isConfigured: () => true,
    chatCompletion: async (args) => { captured = args; return 'Right under this chat.'; },
  };
  const history = [
    { role: 'user', content: 'where are my scribe drafts' },
    { role: 'assistant', content: 'You have 1 waiting.' },
  ];
  const r = await assistant.chat('where are they located', fakeTdb(), history, client);
  assert.equal(r.provider, 'spark');
  assert.ok(captured.user.includes('Conversation so far'), 'transcript included');
  assert.ok(captured.user.includes('where are my scribe drafts'), 'earlier turn included');
  assert.ok(captured.user.includes('Latest customer message: where are they located'), 'latest message marked');
});

test('a Spark failure falls back to the insight engine, never an invented answer', async () => {
  const client = {
    isConfigured: () => true,
    chatCompletion: async () => { throw new Error('spark_http_500'); },
  };
  const r = await assistant.chat('where are my scribe drafts', fakeTdb(), [], client);
  assert.equal(r.provider, 'insights');
  assert.ok(r.reply.includes('Film Manna Promo Video'), 'insight engine answers from the same data');
});

test('an unconfigured Spark slot leaves the insight engine in charge', async () => {
  let called = false;
  const client = {
    isConfigured: () => false,
    chatCompletion: async () => { called = true; return 'should not happen'; },
  };
  const r = await assistant.chat('where are my scribe drafts', fakeTdb(), [], client);
  assert.equal(r.provider, 'insights');
  assert.equal(called, false, 'chatCompletion never called');
});
