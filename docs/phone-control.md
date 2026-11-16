# Phone control (Android)

The voice assistant can read and operate the phone during a call. Ported from
z0live's accessibility service and phone lane.

## Turning it on

Tap the phone button on the live screen, then enable **Voice phone control** in
Android Accessibility settings. New calls then get two extra tools, and the app
keeps the call alive through a microphone foreground service while you are in
other apps.

## Two ways an action happens

1. **The voice model** calls `phone_screen` (visible controls and the current
   app; never passwords or typed field values) and `phone_act` (one action from
   a closed catalog). Calls travel down the `/api/live-tools` stream as `phone`
   frames; the app runs them and posts the result to `/api/phone-result`. Both
   routes must reach the same server process (true for `expo start` and a
   single Node server).
2. **The speech lane** sees each finished sentence you say, on the device:
   - Tier 0: a deterministic grammar (`go home`, `open Spotify`, `scroll down`,
     `skip this song`, `turn it up`, `tap Settings`). Runs in under a millisecond.
   - Tier 1: if the sentence only *sounds* like a phone command, one
     closed-catalog choice from a local decision model (any OpenAI-compatible
     server: llama.cpp, vLLM, Ollama, or a router).
   - A hit acts at once, before the voice model replies. When the voice model
     then asks for the same action within 8 s it gets the lane's result with
     `already_done`, so nothing happens twice. Misses do nothing.

Configure tier 1 at build time:

```sh
EXPO_PUBLIC_DECISION_ENDPOINTS='[{"url":"http://192.168.1.10:8080/v1/chat/completions","model":"qwen3-4b"}]'
```

Endpoints are tried in order with a 2.5 s timeout each; a broken tier declines
instead of guessing.

## Catalog and safety

back, home, recents, notifications, quick settings, lock, screenshot; scroll;
open app; tap by visible label; type into a field; media play/pause/next/
previous; volume up/down/mute.

- Nothing sends, buys, deletes, calls or unlocks by itself. Taps whose label
  looks risky (send, pay, buy, delete, install, call, allow, share...) need
  `confirmed: true`, which only the voice model can set after asking you. The
  speech lane never taps them.
- Password fields are never read or typed into.
- Every result reports `landed`: whether the screen (or volume) visibly changed.
  A tap Android accepted that changed nothing is reported as such.
- Ambiguous targets return `candidates` instead of picking one.

iOS has no API for operating other apps, so the module is absent there and
the tools are never offered.
