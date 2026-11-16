import type { LiveSnapshot } from '../live/types';
import type { LaneOutcome } from './lane';

type Source = { subscribe(listener: () => void): () => void; getSnapshot(): LiveSnapshot };
type Lane = { hear(transcript: string): Promise<LaneOutcome | null> };

/** Captions stream in as deltas; a user line counts as finished after this much quiet. */
export const UTTERANCE_QUIET_MS = 700;

/**
 * Feeds each finished user utterance to the phone lane exactly once. A line is
 * finished when its captions stop growing, or as soon as the assistant starts
 * answering after it.
 */
export function attachPhoneLane(
  session: Source,
  lane: Lane,
  {
    quietMs = UTTERANCE_QUIET_MS,
    onOutcome,
    timers = { set: setTimeout, clear: clearTimeout },
  }: {
    quietMs?: number;
    onOutcome?: (outcome: LaneOutcome) => void;
    timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
  } = {},
) {
  const heard = new Set<string>();
  let pending: { id: string; text: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timers.clear(timer);
    const line = pending;
    pending = null;
    if (!line || heard.has(line.id) || !line.text.trim()) return;
    heard.add(line.id);
    void lane.hear(line.text.trim()).then((outcome) => outcome && onOutcome?.(outcome));
  };

  const unsubscribe = session.subscribe(() => {
    const entries = session.getSnapshot().transcript;
    const lastUser = entries.findLastIndex((entry) => entry.role === 'user');
    if (lastUser < 0) return;
    const entry = entries[lastUser];
    if (heard.has(entry.id)) return;
    if (pending && pending.id !== entry.id) flush(); // a new line started
    const answered = entries.slice(lastUser + 1).some((later) => later.role === 'assistant');
    if (pending?.id === entry.id && pending.text === entry.text && !answered) return; // unrelated update
    pending = { id: entry.id, text: entry.text };
    if (answered) return flush();
    timers.clear(timer);
    timer = timers.set(flush, quietMs);
  });

  return () => {
    unsubscribe();
    timers.clear(timer);
    pending = null;
  };
}
