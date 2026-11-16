import { AgentControl } from '../../modules/agent-control';
import type { PhoneRequest } from '../live/tool-connection';
import { validate, type PhoneAction } from './commands';
import { chainChat, parseEndpoints, PhoneExecutor, PhoneLane, type PhoneResult } from './lane';

const parse = (raw: string): PhoneResult => {
  try {
    return JSON.parse(raw) as PhoneResult;
  } catch {
    return { ok: false, error: 'phone_control_failed' };
  }
};

/** Android only, once the user enables the app's accessibility service. */
export const phoneControl = {
  supported: AgentControl !== null,
  enabled: () => AgentControl?.isEnabled() ?? false,
  openSettings: () => AgentControl?.openSettings(),
  startCall: () => AgentControl?.startCall(),
  stopCall: () => AgentControl?.stopCall(),
};

async function act(action: PhoneAction): Promise<PhoneResult> {
  if (!AgentControl?.isEnabled()) return { ok: false, error: 'permission_required' };
  return parse(await AgentControl.act(JSON.stringify(action)));
}

export const executor = new PhoneExecutor(act);

const endpoints = parseEndpoints(process.env.EXPO_PUBLIC_DECISION_ENDPOINTS);
export const lane = new PhoneLane(executor, endpoints.length ? chainChat(endpoints) : undefined);

export const phoneHandler = AgentControl
  ? {
      available: phoneControl.enabled,
      async handle(request: PhoneRequest): Promise<string> {
        if (!AgentControl?.isEnabled())
          return JSON.stringify({
            ok: false,
            error: 'permission_required',
            message: 'Ask the user to turn on phone control in the app.',
          });
        if (request.tool === 'screen') return AgentControl.screen();
        const action = validate(request.choice);
        if (!action) return JSON.stringify({ ok: false, error: 'invalid_action' });
        return JSON.stringify(await executor.run(action, 'model'));
      },
    }
  : undefined;
