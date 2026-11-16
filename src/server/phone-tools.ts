// Phone tools run on the user's Android phone, not on this server. A call is
// sent down the open /api/live-tools stream as a `phone` frame; the app runs it
// through its accessibility service and posts the result to /api/phone-result.
// Both requests must reach the same server process (true for `expo start` and
// a single Node server; a multi-isolate host needs shared storage instead).

import { DIRECTIONS, GLOBALS, MEDIA, VOLUME, validate } from '../phone/commands';
import {
  authorize,
  failure,
  LiveRequestError,
  readBody,
  validSessionId,
  type ServerOptions,
} from './http';

const ACTIONS = [...GLOBALS, 'scroll', 'open_app', 'tap', 'type', 'media', 'volume'] as const;
const VALUE_FOR: Record<string, string> = {
  scroll: 'direction',
  open_app: 'app',
  tap: 'target',
  type: 'text',
  media: 'action',
  volume: 'action',
};
const MAX_RESULT = 32_768;

export const phoneToolDefinitions = [
  {
    type: 'function' as const,
    name: 'phone_screen',
    description:
      "Read the user's Android phone screen: the app in front and its visible labelled controls (text, clickable, editable, scrollable). Call before tapping something you have not seen. Typed field values and passwords are never returned.",
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'phone_act',
    description: `Operate the user's Android phone, anywhere on the screen. One action per call; read the screen again before the next tap. value: for scroll ${DIRECTIONS.join('|')}; open_app the app name; tap the exact visible label; type the text (replaces the focused field, never submits); media ${MEDIA.join('|')}; volume ${VOLUME.join('|')}; null for the rest. Tapping send, pay, buy, delete, install, call, allow or similar needs the user's spoken yes first; then set confirmed true. landed:true means the screen visibly changed; never claim success without it.`,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        value: { type: ['string', 'null'] },
        confirmed: { type: 'boolean' },
      },
      required: ['action', 'value', 'confirmed'],
      additionalProperties: false,
    },
  },
];

export const phoneToolNames = new Set(phoneToolDefinitions.map((tool) => tool.name));

const failed = (code: string, message: string) =>
  JSON.stringify({ ok: false, error: { code, message } });

/** phone_act's flat arguments -> a validated catalog choice, or null. */
export function catalogChoice(args: unknown) {
  if (!args || typeof args !== 'object') return null;
  const { action, value, confirmed } = args as Record<string, unknown>;
  if (typeof action !== 'string') return null;
  const key = VALUE_FOR[action];
  const choice = {
    action,
    args: key
      ? { [key]: value, ...(action === 'tap' && confirmed === true ? { confirmed: true } : {}) }
      : {},
  };
  return validate(choice) ? choice : null;
}

export type PhoneFrame = {
  type: 'phone';
  id: string;
  tool: 'screen' | 'act';
  choice?: { action: string; args: Record<string, unknown> };
};

const bridges = new Map<string, PhoneBridge>();

export class PhoneBridge {
  private pending = new Map<string, (result: string) => void>();
  private sequence = 0;

  constructor(
    private sessionId: string,
    private emit: (frame: PhoneFrame) => void,
    private timeoutMs = 15_000,
  ) {
    bridges.get(sessionId)?.close();
    bridges.set(sessionId, this);
  }

  call(name: string, argumentsJson: string, signal?: AbortSignal): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      return Promise.resolve(failed('invalid_arguments', 'Tool arguments must be JSON.'));
    }
    let frame: Omit<PhoneFrame, 'id'>;
    if (name === 'phone_screen') frame = { type: 'phone', tool: 'screen' };
    else if (name === 'phone_act') {
      const choice = catalogChoice(args);
      if (!choice)
        return Promise.resolve(
          failed('invalid_arguments', 'Use one catalog action with the value it needs.'),
        );
      frame = { type: 'phone', tool: 'act', choice };
    } else return Promise.resolve(failed('unknown_tool', 'This tool is not available.'));
    if (signal?.aborted) return Promise.resolve(failed('tool_cancelled', 'Cancelled.'));

    const id = `p${++this.sequence}`;
    return new Promise((resolve) => {
      const done = (result: string) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(result);
      };
      const onAbort = () => done(failed('tool_cancelled', 'Cancelled.'));
      const timer = setTimeout(
        () => done(failed('phone_timeout', 'The phone did not answer. It may be offline.')),
        this.timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, done);
      try {
        this.emit({ ...frame, id });
      } catch {
        done(failed('phone_unreachable', 'The phone connection is closed.'));
      }
    });
  }

  resolve(id: string, result: string): boolean {
    const done = this.pending.get(id);
    if (!done) return false;
    done(result.length > MAX_RESULT ? failed('result_too_large', 'Too much screen data.') : result);
    return true;
  }

  close() {
    if (bridges.get(this.sessionId) === this) bridges.delete(this.sessionId);
    for (const done of [...this.pending.values()])
      done(failed('tool_cancelled', 'The call ended.'));
  }
}

export function createPhoneResultHandler(options: ServerOptions) {
  return async function POST(request: Request) {
    try {
      authorize(request, options);
      const body = await readBody(request);
      if (
        !validSessionId(body.sessionId) ||
        typeof body.id !== 'string' ||
        !/^p\d{1,9}$/.test(body.id) ||
        typeof body.result !== 'string'
      ) {
        throw new LiveRequestError('Send sessionId, id and result.', 400, 'invalid_phone_result');
      }
      const accepted = bridges.get(body.sessionId)?.resolve(body.id, body.result) ?? false;
      return new Response(null, {
        status: accepted ? 204 : 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      return failure(error, options);
    }
  };
}
