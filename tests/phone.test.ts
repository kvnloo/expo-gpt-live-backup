import assert from 'node:assert/strict';
import test from 'node:test';

import type { LiveSnapshot, TranscriptEntry } from '../src/live/types';
import { attachPhoneLane } from '../src/phone/attach';
import { parse, soundsLikePhoneCommand, validate, type PhoneAction } from '../src/phone/commands';
import {
  chainChat,
  describeAction,
  parseEndpoints,
  PhoneExecutor,
  PhoneLane,
} from '../src/phone/lane';
import { catalogChoice, createPhoneResultHandler, PhoneBridge } from '../src/server/phone-tools';

test('the grammar maps plain commands and declines questions and chat', () => {
  assert.deepEqual(parse('Go home'), { kind: 'global', action: 'home' });
  assert.deepEqual(parse('okay can you go back please'), { kind: 'global', action: 'back' });
  assert.deepEqual(parse('open Spotify'), { kind: 'open_app', app: 'spotify' });
  assert.deepEqual(parse('scroll down a bit'), { kind: 'scroll', direction: 'down' });
  assert.deepEqual(parse('skip this song'), { kind: 'media', action: 'next' });
  assert.deepEqual(parse('turn it up'), { kind: 'volume', action: 'up' });
  assert.deepEqual(parse('tap settings'), { kind: 'tap', target: 'settings' });
  assert.equal(parse('tap send'), null, 'risky taps never come from the grammar');
  assert.equal(parse('what is on my screen'), null);
  assert.equal(parse('I went home yesterday and it was nice'), null);
  assert.equal(soundsLikePhoneCommand('could you open the camera thing'), true);
  assert.equal(soundsLikePhoneCommand('why is the sky blue'), false);
});

test('validate accepts only well-typed catalog actions', () => {
  assert.deepEqual(validate({ action: 'scroll', args: { direction: 'up' } }), {
    kind: 'scroll',
    direction: 'up',
  });
  assert.equal(validate({ action: 'scroll', args: { direction: 'sideways' } }), null);
  assert.equal(validate({ action: 'send_message', args: {} }), null);
  assert.equal(validate({ action: 'open_app', args: { app: 'x'.repeat(61) } }), null);
  assert.equal(validate({ action: null }), null);
  assert.deepEqual(catalogChoice({ action: 'tap', value: 'Pay', confirmed: true }), {
    action: 'tap',
    args: { target: 'Pay', confirmed: true },
  });
  assert.equal(catalogChoice({ action: 'tap' }), null);
});

test('the voice model gets the lane result instead of acting twice', async () => {
  let now = 0;
  const done: PhoneAction[] = [];
  const executor = new PhoneExecutor(
    async (action) => {
      done.push(action);
      return { ok: true, landed: true };
    },
    () => now,
  );
  const home: PhoneAction = { kind: 'global', action: 'home' };
  await executor.run(home, 'lane');
  assert.deepEqual(await executor.run(home, 'model'), {
    ok: true,
    landed: true,
    already_done: true,
  });
  assert.equal(done.length, 1);
  now = 9_000;
  await executor.run(home, 'model');
  assert.equal(done.length, 2, 'a repeat after the window acts again');
});

test('the lane uses the grammar first, the local model second, and never taps risky labels', async () => {
  const acted: PhoneAction[] = [];
  const executor = new PhoneExecutor(async (action) => {
    acted.push(action);
    return { ok: true, landed: true };
  });
  const replies: Record<string, string> = {
    camera: 'Sure: {"action":"open_app","args":{"app":"Camera"}}',
    buy: '{"action":"tap","args":{"target":"Buy now","confirmed":true}}',
    broken: 'no idea',
  };
  const prompts: string[] = [];
  const lane = new PhoneLane(executor, async (prompt) => {
    prompts.push(prompt);
    const key = Object.keys(replies).find((k) => prompt.includes(k)) ?? 'broken';
    return { text: replies[key], model: 'qwen3-4b' };
  });

  const grammar = await lane.hear('go home');
  assert.equal(grammar?.tier, 'grammar');
  assert.equal(prompts.length, 0, 'grammar hits never call the model');

  const model = await lane.hear('get the camera open for me');
  assert.equal(model?.tier, 'model');
  assert.deepEqual(model?.action, { kind: 'open_app', app: 'Camera' });
  assert.match(describeAction(model!), /^open Camera · done · model \d+ ms$/);

  assert.equal(await lane.hear('press that buy now button'), null);
  assert.equal(await lane.hear('the broken thing, open it'), null);
  assert.equal(await lane.hear('how are you today'), null);
  assert.equal(prompts.length, 3, 'questions never reach the model');
  assert.equal(acted.length, 2);
});

test('chainChat falls through to the next local endpoint', async () => {
  const urls: string[] = [];
  const chat = chainChat(
    [
      { url: 'http://127.0.0.1:1/v1/chat/completions', model: 'down' },
      { url: 'http://127.0.0.1:2/v1/chat/completions', model: 'qwen3-4b' },
    ],
    {
      fetch: (async (url: string) => {
        urls.push(url);
        if (url.includes(':1/')) return new Response('nope', { status: 503 });
        return Response.json({ choices: [{ message: { content: '{"action":"home"}' } }] });
      }) as typeof fetch,
    },
  );
  assert.deepEqual(await chat('x'), { text: '{"action":"home"}', model: 'qwen3-4b' });
  assert.equal(urls.length, 2);
  assert.deepEqual(
    parseEndpoints('[{"url":"ftp://x","model":"a"},{"url":"http://h/v1","model":"b"}]'),
    [{ url: 'http://h/v1', model: 'b' }],
  );
});

function fakeSession() {
  let snapshot = { transcript: [] as TranscriptEntry[] } as LiveSnapshot;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    say(entries: Partial<TranscriptEntry>[]) {
      snapshot = {
        ...snapshot,
        transcript: entries.map(
          (e, i) => ({ id: `e${i}`, role: 'user', text: '', startMs: i, ...e }) as TranscriptEntry,
        ),
      };
      listeners.forEach((l) => l());
    },
  };
}

test('each finished user line reaches the lane once', async () => {
  const session = fakeSession();
  const heard: string[] = [];
  const timers: (() => void)[] = [];
  attachPhoneLane(
    session,
    { hear: async (text) => (heard.push(text), null) },
    {
      timers: {
        set: ((fn: () => void) => (timers.push(fn), timers.length)) as unknown as typeof setTimeout,
        clear: (() => {}) as typeof clearTimeout,
      },
    },
  );
  session.say([{ id: 'u1', text: 'open' }]);
  session.say([{ id: 'u1', text: 'open spotify' }]);
  assert.deepEqual(heard, [], 'still speaking');
  session.say([
    { id: 'u1', text: 'open spotify' },
    { id: 'a1', role: 'assistant', text: 'Sure' },
  ]);
  assert.deepEqual(heard, ['open spotify'], 'the assistant answering ends the line');
  timers.forEach((fn) => fn());
  session.say([
    { id: 'u1', text: 'open spotify' },
    { id: 'a1', role: 'assistant', text: 'Sure, opening' },
  ]);
  assert.deepEqual(heard, ['open spotify'], 'never twice');
  session.say([
    { id: 'u1', text: 'open spotify' },
    { id: 'u2', text: 'go home' },
  ]);
  timers.at(-1)!();
  assert.deepEqual(heard, ['open spotify', 'go home'], 'quiet ends a line');
});

test('phone tool calls round-trip through the app and the result route', async () => {
  const frames: { id: string; tool: string; choice?: unknown }[] = [];
  const bridge = new PhoneBridge('sess_1', (frame) => frames.push(frame));
  const pending = bridge.call('phone_act', JSON.stringify({ action: 'open_app', value: 'Maps' }));
  assert.deepEqual(frames[0], {
    type: 'phone',
    tool: 'act',
    choice: { action: 'open_app', args: { app: 'Maps' } },
    id: 'p1',
  });

  const post = createPhoneResultHandler({ apiKey: 'k', apiToken: 't', requireApiToken: true });
  const send = (token: string, body: unknown) =>
    post(
      new Request('http://x/api/phone-result', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await send('wrong', { sessionId: 'sess_1', id: 'p1', result: '{}' })).status, 401);
  assert.equal(
    (await send('t', { sessionId: 'sess_1', id: 'p1', result: '{"ok":true,"landed":true}' }))
      .status,
    204,
  );
  assert.equal(await pending, '{"ok":true,"landed":true}');
  assert.equal(
    (await send('t', { sessionId: 'sess_1', id: 'p1', result: '{}' })).status,
    404,
    'answered once',
  );

  assert.match(await bridge.call('phone_act', '{"action":"delete_all"}'), /invalid_arguments/);
  const orphan = bridge.call('phone_screen', '{}');
  bridge.close();
  assert.match(await orphan, /tool_cancelled/);
});
