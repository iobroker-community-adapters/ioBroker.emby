# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

ioBroker adapter for [Emby](https://emby.media/). It connects to the Emby server via WebSocket, mirrors every
client as a device `<deviceKey>` (derived from the Emby device id, see `deviceKey()`) with now-playing data, and lets the user control clients (play/pause,
mute, volume, messages) via the REST API.

## Commands

```bash
npm run build              # tsc -p tsconfig.build.json: src/ -> build/ (gitignored, common.nogit: true)
npm run check              # type check only
npm run lint               # eslint (@iobroker/eslint-config); fix with: npx eslint -c eslint.config.mjs --fix src
npm test                   # = test:package
npm run test:integration   # starts a real js-controller, fails if one is already running on the machine;
                           # test/integrationEmby.js runs against a mock Emby server (HTTP + WebSocket, port 18096)
npm run translate          # translate admin/i18n/en.json into the other languages
```

There is no `prepare` script on purpose: the build only runs via `npm run build` and in CI (`build: true`).
There is no `tasks.ts`: the admin is pure JsonConfig, so nothing is left to do besides `tsc`.

## Architecture

- `src/main.ts` — `EmbyAdapter extends utils.Adapter`, compact-mode export at the end.
  - `onReady`: migrates a plain-text API key (`migratePlainApiKey`), opens the WebSocket (`tryConnect`) and starts
    the REST poll (`startPolling`, `pollInterval` s, default 60, 0 = off).
  - WebSocket (native `WebSocket`, Node >= 22): `ws(s)://<ip>?api_key=…&deviceId=ioBroker-<namespace>`.
    On open: `SessionsStart`, KeepAlive every 30 s (or half of `ForceKeepAlive`), `refreshSessions()`.
    On close: reconnect after 60 s. Only `Sessions` messages are processed as session lists.
  - REST (native `fetch`): API key as `X-Emby-Token` header, never in the URL. `GET /Sessions`, `GET /Devices`,
    `POST /Sessions/<id>/…` for commands.
  - `handleSessions()` runs serialised through `sessionQueue`. Sessions are grouped by device key (several sessions
    of one client, e.g. browser tabs → `preferSession()`). Per client: `createDeviceObjects()` (only when the
    signature name/remote control/supported commands changes) and `updateSession()`. `sessionOf` maps device key →
    current session id for the REST commands. Clients no longer reported are marked offline (`info.online = false`,
    media cleared, `media.state = idle`).
  - `media.state` changes away from `playing` are delayed by `timeout` ms (`changeState`).
  - Cleanup (`cleanupDevices`, after each REST poll): objects of clients deleted in the Emby dashboard
    (`removeDeletedDevices`) or inactive for `removeInactiveDays` days are deleted. Active sessions never.
  - Object ids: `deviceKey()` uses the Emby device id if it matches `[A-Za-z0-9_-]{1,40}`, otherwise the first 16
    hex chars of its sha1 (web clients send long base64 ids). Since 3.0.0; up to 2.x the session id was used.
  - Migration (3.0.0): `migrateStoredDevices()` on start moves objects of 2.x (`native.deviceId` set) to the device
    key, `handleSessions()` moves objects of 1.3.0 (no `native.deviceId`) when the session is reported again.
    `migrateDevice()` copies objects incl. `common.custom`, the current values and enum memberships, then deletes
    the old objects.
  - `onStateChange`: writes to `<sid>.command.*` are sent to the server; writes to info/media/posters are acked.
- `src/lib/types.ts` — Emby payloads (sessions, devices, socket messages).
- `src/lib/adapter-config.d.ts` — typed `this.config`; must match `native` in `io-package.json` and
  `admin/jsonConfig.json`.

## Conventions

- Object IDs, roles, `native` keys and defaults must not change — existing installations depend on them. The
  exception was the switch to device keys in 3.0.0, which comes with `migrateDevice()` and the upgrade message in
  `common.messages`.
- Do not name methods like `utils.Adapter` methods (`createDevice`, `createState`, …): a private method with the
  same name overrides the adapter API.
- Timers only via `this.setTimeout` / `this.setInterval` so they are cleared on unload.
- `apikey` is in `encryptedNative`/`protectedNative` since 2.0.0. Keys stored in plain text by <= 1.3.0 arrive
  garbled in `this.config`; `migratePlainApiKey()` reads the raw instance object and encrypts 32-hex keys once.
- `pollInterval` / `removeDeletedDevices` are `undefined` for instances created by <= 1.3.0, the code falls back
  to the io-package defaults.
- The adapter's own WebSocket session (`ioBroker-<namespace>`, old fixed id `00001`) is never created as device.
- Comments marked `@KI_HINWEIS` document observed Emby behaviour (no answer to KeepAlive, Sessions only on changes,
  web clients toggling `SupportsRemoteControl`) — keep them.

## Release

`npm run release-patch|minor|major` (`@alcalzone/release-script`, plugins `iobroker`, `license`, `manual-review`).
Add changelog lines under `### **WORK IN PROGRESS**` in `README.md`; do not edit `common.news` by hand.
