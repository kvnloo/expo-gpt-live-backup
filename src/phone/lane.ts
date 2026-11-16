import {
  actionKey,
  chooserPrompt,
  isUnsafeTarget,
  parse,
  soundsLikePhoneCommand,
  validate,
  type PhoneAction,
} from './commands';

export type PhoneResult = {
  ok: boolean;
  /** The screen (or volume) visibly changed after the action; null when unknowable. */
  landed?: boolean | null;
  error?: string;
  candidates?: string[];
  already_done?: boolean;
  [key: string]: unknown;
};

export type Endpoint = { url: string; model: string; extra?: Record<string, unknown> };
export type Chat = (prompt: string) => Promise<{ text: string; model: string }>;

const DEDUPE_MS = 8_000;

/**
 * Runs catalog actions on the phone and remembers what the speech lane did, so
 * when the voice model asks for the same action a moment later it gets the
 * lane's result instead of doing it twice.
 */
export class PhoneExecutor {
  private recent: { key: string; at: number; result: PhoneResult }[] = [];

  constructor(
    private native: (action: PhoneAction) => Promise<PhoneResult>,
    private now: () => number = Date.now,
  ) {}

  async run(action: PhoneAction, source: 'lane' | 'model'): Promise<PhoneResult> {
    const key = actionKey(action);
    const at = this.now();
    this.recent = this.recent.filter((entry) => at - entry.at < DEDUPE_MS);
    if (source === 'model') {
      const done = this.recent.find((entry) => entry.key === key);
      if (done) return { ...done.result, already_done: true };
    }
    let result: PhoneResult;
    try {
      result = await this.native(action);
    } catch {
      result = { ok: false, error: 'phone_control_failed' };
    }
    if (source === 'lane' && result.ok) this.recent.push({ key, at, result });
    return result;
  }
}

export type LaneOutcome = {
  tier: 'grammar' | 'model';
  action: PhoneAction;
  result: PhoneResult;
  ms: number;
  model?: string;
};

/**
 * The speech-to-action lane: each finished user utterance is offered to a
 * deterministic grammar, then (only if it sounds like a phone command) to one
 * closed-catalog choice from a fast local decision model. A hit acts on the
 * phone immediately, without waiting for the voice model's delegation round
 * trip. Misses do nothing; the voice model still hears every word.
 */
export class PhoneLane {
  constructor(
    private executor: PhoneExecutor,
    private chat?: Chat,
    private now: () => number = Date.now,
  ) {}

  async decide(transcript: string): Promise<Omit<LaneOutcome, 'result'> | null> {
    const started = this.now();
    const grammar = parse(transcript);
    if (grammar) return { tier: 'grammar', action: grammar, ms: this.now() - started };
    if (!this.chat || !soundsLikePhoneCommand(transcript)) return null;
    let reply: { text: string; model: string };
    try {
      reply = await this.chat(chooserPrompt(transcript));
    } catch {
      return null; // a broken tier declines; it never guesses
    }
    const action = validate(firstJSON(reply.text));
    // The lane never taps risky controls; the voice model asks first.
    if (!action || (action.kind === 'tap' && isUnsafeTarget(action.target))) return null;
    if (action.kind === 'tap') delete action.confirmed;
    return { tier: 'model', action, ms: this.now() - started, model: reply.model };
  }

  async hear(transcript: string): Promise<LaneOutcome | null> {
    const decision = await this.decide(transcript);
    if (!decision) return null;
    const result = await this.executor.run(decision.action, 'lane');
    return { ...decision, result };
  }
}

/** A short caption for the screen: what the lane did and whether it landed. */
export function describeAction({ action, result, tier, ms }: LaneOutcome): string {
  const what =
    action.kind === 'global'
      ? action.action.replace('_', ' ')
      : action.kind === 'scroll'
        ? `scroll ${action.direction}`
        : action.kind === 'open_app'
          ? `open ${action.app}`
          : action.kind === 'tap'
            ? `tap ${action.target}`
            : action.kind === 'type'
              ? 'type text'
              : `${action.kind} ${action.action}`;
  const how = !result.ok
    ? `failed: ${result.error ?? 'unknown'}`
    : result.landed === false
      ? 'no change'
      : 'done';
  return `${what} · ${how} · ${tier} ${Math.round(ms)} ms`;
}

export function firstJSON(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text ?? '');
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Endpoints in order; the first JSON-bearing reply wins. Point these at a
 * local OpenAI-compatible server (llama.cpp, vLLM, Ollama) or a router.
 */
export function chainChat(
  endpoints: Endpoint[],
  { fetch: send = fetch, timeoutMs = 2_500 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Chat {
  return async (prompt) => {
    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await send(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'agent-phone-lane/1' },
          body: JSON.stringify({
            model: endpoint.model,
            temperature: 0,
            max_tokens: 120,
            messages: [{ role: 'user', content: prompt }],
            ...endpoint.extra,
          }),
          signal: controller.signal,
        });
        if (!response.ok) continue;
        const body = (await response.json()) as {
          model?: string;
          choices?: { message?: { content?: string } }[];
        };
        const text = body.choices?.[0]?.message?.content ?? '';
        if (firstJSON(text) !== null) return { text, model: body.model ?? endpoint.model };
      } catch {
        // try the next endpoint
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('no decision endpoint answered');
  };
}

/** `EXPO_PUBLIC_DECISION_ENDPOINTS`: a JSON array of {url, model, extra?}. */
export function parseEndpoints(raw: string | undefined): Endpoint[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is Endpoint =>
        !!entry &&
        typeof entry.url === 'string' &&
        /^https?:\/\//.test(entry.url) &&
        typeof entry.model === 'string' &&
        entry.model.length > 0,
    );
  } catch {
    return [];
  }
}
