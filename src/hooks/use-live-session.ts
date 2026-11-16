import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { LiveSession } from '@/live/session';
import { createTransport } from '@/live/transport';
import { sessionAPI } from '@/live/api';
import { attachPhoneLane } from '@/phone/attach';
import { lane, phoneControl } from '@/phone/device';
import { describeAction } from '@/phone/lane';

export function useLiveSession() {
  const [session] = useState(() => new LiveSession(createTransport, sessionAPI));
  const [phoneEnabled, setPhoneEnabled] = useState(phoneControl.enabled);
  const [lastPhoneAction, setLastPhoneAction] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    const onAppStateChange = (state: typeof AppState.currentState) => {
      // Native iOS audio continues while the screen is locked or another app is
      // open. Only visual updates pause; the microphone keeps its chosen state.
      session.setAppActive(state === 'active');
      // The user may have just come back from Accessibility settings.
      if (state === 'active') setPhoneEnabled(phoneControl.enabled());
      // With phone control on, opening other apps is the point: the call
      // service keeps the microphone alive instead.
      if (state === 'background' && process.env.EXPO_OS !== 'ios' && !phoneControl.enabled())
        void session.stop();
    };
    onAppStateChange(AppState.currentState);
    const listener = AppState.addEventListener('change', onAppStateChange);
    // Every finished sentence the user says is also offered to the on-device
    // phone lane, which acts on simple commands before the voice model replies.
    const detach = phoneControl.supported
      ? attachPhoneLane(
          session,
          { hear: (text) => (phoneControl.enabled() ? lane.hear(text) : Promise.resolve(null)) },
          { onOutcome: (outcome) => setLastPhoneAction(describeAction(outcome)) },
        )
      : () => {};
    return () => {
      listener.remove();
      detach();
      void session.stop();
    };
  }, [session]);
  const live = snapshot.status === 'connecting' || snapshot.status === 'connected';
  useEffect(() => {
    if (!phoneControl.supported || !live || !phoneEnabled) return;
    phoneControl.startCall();
    return () => phoneControl.stopCall();
  }, [live, phoneEnabled]);
  return {
    ...snapshot,
    start: session.start,
    stop: session.stop,
    toggleMute: session.toggleMute,
    phone: {
      supported: phoneControl.supported,
      enabled: phoneEnabled,
      lastAction: lastPhoneAction,
      openSettings: phoneControl.openSettings,
    },
  };
}
