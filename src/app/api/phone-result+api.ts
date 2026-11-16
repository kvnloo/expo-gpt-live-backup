import { createPhoneResultHandler } from '../../server/phone-tools';

export function POST(request: Request) {
  return createPhoneResultHandler({
    apiKey: process.env.OPENAI_API_KEY,
    apiToken: process.env.API_TOKEN,
    requireApiToken: true,
  })(request);
}
