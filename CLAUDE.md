# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

ioBroker adapter for [Emby](https://emby.media/). It connects to the Emby server via WebSocket, mirrors every
client session as a device `<sessionId>` with now-playing data, and lets the user control clients (play/pause,
mute, volume, messages) via the REST API.

## Commands

```bash
npm run build              # tsc -p tsconfig.build.json: src/ -> build/ (gitignored, common.nogit: true)
npm run check              # type check only
npm run lint               # eslint (@iobroker/eslint-config); fix with: npx eslint -c eslint.config.mjs --fix src
npm test                   # = test:package
npm run test:integration   # starts a real js-controller, fails if one is already running on the machine
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
  - `handleSessions()` runs serialised through `sessionQueue`. Per session: `createSessionObjects()` (only when the
    signature name/remote control/supported commands changes) and `updateSession()`. Sessions no longer reported
    are marked offline (`info.online = false`, media cleared, `media.state = idle`).
  - `media.state` changes away from `playing` are delayed by `timeout` ms (`changeState`).
  - Cleanup (`cleanupDevices`, after each REST poll): objects of clients deleted in the Emby dashboard
    (`removeDeletedDevices`) or inactive for `removeInactiveDays` days are deleted. Active sessions never.
  - Emby assigns a new session id on every reconnect of a client; the device object stores `native.deviceId`
    and `removeSupersededSessions()` deletes the objects of the old session id.
  - `onStateChange`: writes to `<sid>.command.*` are sent to the server; writes to info/media/posters are acked.
- `src/lib/types.ts` — Emby payloads (sessions, devices, socket messages).
- `src/lib/adapter-config.d.ts` — typed `this.config`; must match `native` in `io-package.json` and
  `admin/jsonConfig.json`.

## Conventions

- Object IDs, roles, `native` keys and defaults must not change — existing installations depend on them.
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
