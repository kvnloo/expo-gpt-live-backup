// The closed catalog of phone actions shared by the voice model's phone_act
// tool and the on-device speech lane. Every action is reversible or asks for
// confirmation; nothing here sends, buys, deletes, calls or unlocks.

export const GLOBALS = [
  'back',
  'home',
  'recents',
  'notifications',
  'quick_settings',
  'lock',
  'screenshot',
] as const;
export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export const MEDIA = ['play', 'pause', 'next', 'previous'] as const;
export const VOLUME = ['up', 'down', 'mute'] as const;

export type GlobalAction = (typeof GLOBALS)[number];
export type PhoneAction =
  | { kind: 'global'; action: GlobalAction }
  | { kind: 'scroll'; direction: (typeof DIRECTIONS)[number] }
  | { kind: 'open_app'; app: string }
  | { kind: 'tap'; target: string; confirmed?: boolean }
  | { kind: 'type'; text: string; target?: string }
  | { kind: 'media'; action: (typeof MEDIA)[number] }
  | { kind: 'volume'; action: (typeof VOLUME)[number] };

export const CATALOG: Record<string, string> = {
  back: 'Android Back',
  home: 'go to the home screen',
  recents: 'show recent apps',
  notifications: 'pull down the notification shade',
  quick_settings: 'open quick settings',
  lock: 'lock the screen',
  screenshot: 'take a screenshot',
  scroll: 'scroll the screen; args {direction: up|down|left|right}',
  open_app: 'launch an installed app; args {app: its name}',
  tap: 'tap the on-screen control with this visible label; args {target}',
  type: 'type text into the focused field; args {text}',
  media: 'media playback; args {action: play|pause|next|previous}',
  volume: 'media volume; args {action: up|down|mute}',
};

/** Labels the speech lane never taps on its own; the voice model must confirm. */
const UNSAFE =
  /\b(send|pay|buy|purchase|order|checkout|confirm|delete|remove|uninstall|install|transfer|call|dial|subscribe|sign ?out|log ?out|reset|erase|post|publish|accept|allow|share)\b/i;

export function isUnsafeTarget(label: string): boolean {
  return UNSAFE.test(label);
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f]/.test(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** Accept a model's or tool caller's choice only if it is a well-typed catalog action. */
export function validate(choice: unknown): PhoneAction | null {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return null;
  const { action, args: rawArgs } = choice as { action?: unknown; args?: unknown };
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  if (oneOf(GLOBALS, action)) return { kind: 'global', action };
  switch (action) {
    case 'scroll':
      return oneOf(DIRECTIONS, args.direction)
        ? { kind: 'scroll', direction: args.direction }
        : null;
    case 'open_app':
      return text(args.app, 60) ? { kind: 'open_app', app: args.app.trim() } : null;
    case 'tap':
      return text(args.target, 120)
        ? {
            kind: 'tap',
            target: args.target.trim(),
            ...(args.confirmed === true ? { confirmed: true } : {}),
          }
        : null;
    case 'type':
      return text(args.text, 500)
        ? {
            kind: 'type',
            text: args.text,
            ...(text(args.target, 120) ? { target: args.target.trim() } : {}),
          }
        : null;
    case 'media':
      return oneOf(MEDIA, args.action) ? { kind: 'media', action: args.action } : null;
    case 'volume':
      return oneOf(VOLUME, args.action) ? { kind: 'volume', action: args.action } : null;
    default:
      return null;
  }
}

/** A stable identity for deduping the lane's action against the model's. */
export function actionKey(action: PhoneAction): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  switch (action.kind) {
    case 'global':
    case 'media':
    case 'volume':
      return `${action.kind}:${action.action}`;
    case 'scroll':
      return `scroll:${action.direction}`;
    case 'open_app':
      return `open_app:${norm(action.app)}`;
    case 'tap':
      return `tap:${norm(action.target)}`;
    case 'type':
      return `type:${action.text}`;
  }
}

const LEAD =
  /^(?:(?:ok(?:ay)?|hey|yeah|so|um|uh)[, ]+)*(?:(?:please|can you|could you|would you|will you|go ahead and|just)\s+)*/;
const TRAIL = /(?:\s+(?:please|for me|now|thanks|thank you))+$/;
const QUESTION = /^(?:what|why|how|when|where|who|which|is|are|do|does|did|should|tell me)\b/;

/**
 * Tier 0: the user's words -> one catalog action, or null. Never guesses:
 * anything it does not fully parse goes to tier 1 or the voice model.
 */
export function parse(transcript: string): PhoneAction | null {
  let t = ' ' + (transcript ?? '').toLowerCase().replace(/[’]/g, "'");
  t = t
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(LEAD, '').replace(TRAIL, '').trim();
  if (!t || t.length > 80 || QUESTION.test(t)) return null;
  const g = (action: GlobalAction): PhoneAction => ({ kind: 'global', action });

  if (/^(?:go |press |hit )?back(?: button)?$|^go back(?: a page| one)?$/.test(t)) return g('back');
  if (/^(?:go )?home(?: screen)?$|^go to (?:the )?home(?: screen)?$/.test(t)) return g('home');
  if (/^(?:show |open )?(?:my )?(?:recent apps|recents|app switcher|recent)$/.test(t))
    return g('recents');
  if (/^(?:open|show|pull down|check)(?: my| the)? notifications?(?: shade)?$/.test(t))
    return g('notifications');
  if (/^(?:open |show |pull down )?(?:the )?quick settings$/.test(t)) return g('quick_settings');
  if (/^lock(?: the| my)? (?:phone|screen)$/.test(t)) return g('lock');
  if (/^(?:take a |grab a )?screenshot$|^screen ?shot$/.test(t)) return g('screenshot');

  const scroll = /^(?:scroll|swipe|page) (up|down|left|right)(?: a bit| more)?$/.exec(t);
  if (scroll) return { kind: 'scroll', direction: scroll[1] as PhoneAction & 'up' };

  const media =
    /^(pause|play|resume|stop|skip|next|previous)(?: (?:the |this |a |that )?(?:music|song|track|playback|it|audio|podcast|video))?$/.exec(
      t,
    );
  if (media) {
    const verb = media[1];
    const action =
      ({ resume: 'play', stop: 'pause', skip: 'next' } as Record<string, string>)[verb] ?? verb;
    return { kind: 'media', action: action as (typeof MEDIA)[number] };
  }
  if (/^(?:next|skip (?:this |the )?)(?:song|track)$/.test(t))
    return { kind: 'media', action: 'next' };
  if (/^(?:previous|last) (?:song|track)$/.test(t)) return { kind: 'media', action: 'previous' };
  if (/^(?:turn (?:it|the volume|the music) up|volume up|louder|make it louder)$/.test(t))
    return { kind: 'volume', action: 'up' };
  if (
    /^(?:turn (?:it|the volume|the music) down|volume down|quieter|softer|make it quieter)$/.test(t)
  )
    return { kind: 'volume', action: 'down' };
  if (/^(?:mute|unmute)(?: (?:the )?(?:music|media|sound|audio|volume))?$/.test(t))
    return { kind: 'volume', action: 'mute' };

  const open = /^(?:open|launch|start|go to) (?:the |my )?([a-z0-9' ]{2,40}?)(?: app)?$/.exec(t);
  if (open && !/^(?:it|that|this|the|a|my)$/.test(open[1]))
    return { kind: 'open_app', app: open[1] };
  const tap =
    /^(?:tap|click|press|hit|select) (?:on )?(?:the )?([a-z0-9' ]{1,60}?)(?: button| tab| link)?$/.exec(
      t,
    );
  if (tap && !isUnsafeTarget(tap[1])) return { kind: 'tap', target: tap[1] };
  const type = /^type (.{1,200})$/.exec(t);
  if (type) return { kind: 'type', text: type[1] };
  return null;
}

/**
 * Only spend a tier-1 model call on words that sound like operating the phone.
 * Questions and chat go straight to the voice model.
 */
export function soundsLikePhoneCommand(transcript: string): boolean {
  const t = transcript.toLowerCase();
  if (t.length > 160 || QUESTION.test(t.replace(LEAD, '').trim())) return false;
  return /\b(open|launch|start|go (?:back|home|to)|tap|click|press|scroll|swipe|type|notifications?|quick settings|recents?|lock|screenshot|pause|play|skip|next|previous|volume|louder|quieter|mute|app)\b/.test(
    t,
  );
}

/** The tier-1 prompt: one catalog choice or null, as JSON. */
export function chooserPrompt(transcript: string): string {
  return (
    "Map the phone owner's spoken request to exactly one phone action, or none.\nActions:\n" +
    Object.entries(CATALOG)
      .map(([name, meaning]) => `- ${name}: ${meaning}`)
      .join('\n') +
    '\nAnything that is not one of these actions (questions, conversation, messages, work, ' +
    'or anything needing more than one step) is null.\n' +
    'Reply with JSON only: {"action": NAME, "args": {...}} or {"action": null}.\n' +
    'Request (data): ' +
    JSON.stringify(transcript.slice(0, 300))
  );
}
