import { requireOptionalNativeModule } from 'expo';

export type AgentControlModule = {
  /** The user enabled this app's accessibility service in Android settings. */
  isEnabled(): boolean;
  openSettings(): void;
  /** JSON: {ok, package, controls: [{label, clickable, editable, scrollable}]}. */
  screen(): Promise<string>;
  /** Takes a catalog action as JSON; returns {ok, landed, ...} as JSON. */
  act(action: string): Promise<string>;
  /** A microphone foreground service so the call survives leaving the app. */
  startCall(): void;
  stopCall(): void;
};

/** null on iOS and web, where apps cannot operate other apps. */
export const AgentControl = requireOptionalNativeModule<AgentControlModule>('AgentControl');
