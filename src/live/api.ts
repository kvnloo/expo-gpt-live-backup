import { fetch } from 'expo/fetch';

import { clearAccessToken, getAccessToken } from './access-token';
import { createSessionAPI } from './api-client';
import { phoneHandler } from '../phone/device';

export const sessionAPI = createSessionAPI({
  fetch,
  isWeb: process.env.EXPO_OS === 'web',
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  getAccessToken,
  clearAccessToken,
  phone: phoneHandler,
});
