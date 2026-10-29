'use strict';

const utils = require('@iobroker/adapter-core');

/** Delay before a new connection attempt after the socket closed. */
const RECONNECT_DELAY_MS = 60_000;
/** Interval for client KeepAlive messages if the server does not request one. */
const DEFAULT_KEEPALIVE_MS = 30_000;
/** Lower limit for the poll interval. */
const MIN_POLL_SECONDS = 5;
/** One day in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Timeout for REST calls to the server. */
const HTTP_TIMEOUT_MS = 10_000;

/**
 * Simple remote commands: state id below `<session>.` → REST path below `/Sessions/<session>/`.
 */
const SIMPLE_COMMANDS = {
    'command.toggleplay': 'Playing/PlayPause',
    'command.play': 'Playing/Unpause',
    'command.pause': 'Playing/Pause',
    'command.mute': 'Command/Mute',
    'command.unmute': 'Command/Unmute',
    'command.togglemute': 'Command/ToggleMute',
    'command.goHome': 'Command/GoHome',
    'command.goToSearch': 'Command/GoToSearch',
    'command.back': 'Command/Back',
};

let adapter;
// WebSocket | null
let connection = null;
let stopping = false;
let retryTimer = null;
let keepAliveTimer = null;
let pollTimer = null;
/** Serialises processing of Sessions messages so slow object creation cannot overlap. */
let sessionQueue = Promise.resolve();

/** Session id → signature (name, remote control, supported commands) of the objects created during this run. */
const createdSessions = new Map();
/** Session ids reported by the server in the last Sessions message. */
let activeSessions = new Set();
let initialSessionsLoaded = false;
/** API key, resolved once at start (see migratePlainApiKey). */
let apiKey = '';

const laststates = {};
const timeoutplays = {};
const timeoutstates = {};
const timeoutstarted = {};

/**
 * Creates the adapter instance.
 *
 * @param {Partial<utils.AdapterOptions>} [options] adapter options
 * @returns {ioBroker.Adapter} adapter instance
 */
function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'emby',
        stateChange: onStateChange,
        objectChange: onObjectChange,
        unload: onUnload,
        ready: () => {
            main().catch(e => adapter.log.error(`Startup failed: ${e.message}`));
        },
    });

    adapter = new utils.Adapter(options);
    return adapter;
}

/**
 * Called when the adapter shuts down. The callback has to be called under any circumstances.
 *
 * @param {() => void} callback done callback
 */
function onUnload(callback) {
    stopping = true;
    try {
        stopTimers();
        Object.keys(timeoutplays).forEach(id => adapter.clearTimeout(timeoutplays[id]));
        if (connection) {
            if (connection.readyState === WebSocket.OPEN) {
                connection.send(JSON.stringify({ MessageType: 'SessionsStop', Data: '' }));
            }
            connection.close();
            connection = null;
        }
        adapter.setState('info.connection', false, true);
    } catch {
        // ignore, we are shutting down anyway
    } finally {
        callback();
    }
}

/** Stops reconnect and keepalive timers. */
function stopTimers() {
    if (retryTimer) {
        adapter.clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (keepAliveTimer) {
        adapter.clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    if (pollTimer) {
        adapter.clearInterval(pollTimer);
        pollTimer = null;
    }
}

/**
 * Base URL of the server for REST calls (honours the SSL option).
 *
 * @returns {string} e.g. http://192.168.0.100:8096
 */
function baseUrl() {
    return `${adapter.config.isSSL ? 'https' : 'http'}://${adapter.config.ip}`;
}

/**
 * Sends a request to the server. The API key is sent as header, never in the URL,
 * so it cannot end up in logs.
 *
 * @param {'GET' | 'POST'} method HTTP method
 * @param {string} path path below the server root, e.g. `Sessions/<id>/Playing/Pause`
 * @param {object} [body] JSON body
 * @returns {Promise<Response>} response (status 2xx)
 */
async function apiRequest(method, path, body) {
    const res = await fetch(`${baseUrl()}/${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Emby-Token': apiKey,
            // same DeviceId as the WebSocket, otherwise the server registers every REST call as an extra client
            'X-Emby-Authorization': `MediaBrowser Client="ioBroker", Device="ioBroker", DeviceId="${ownDeviceId()}", Version="${adapter.version}"`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res;
}

/**
 * Sends a POST request to the server.
 *
 * @param {string} path path below the server root
 * @param {object} [body] JSON body
 */
async function apiPost(path, body) {
    await apiRequest('POST', path, body);
}

/**
 * Queues a list of sessions for processing (WebSocket push or REST poll).
 *
 * @param {unknown} data session list
 */
function queueSessions(data) {
    const list = Array.isArray(data) ? data : [];
    sessionQueue = sessionQueue
        .then(() => handleSessions(list))
        .catch(err => adapter.log.warn(`Error processing sessions: ${err.message}`));
}

/**
 * Reads the current sessions via REST and runs the device cleanup afterwards. Needs an API key.
 *
 * @param {boolean} [quiet] log failures only on debug level (periodic poll)
 */
async function refreshSessions(quiet = false) {
    if (!apiKey) {
        return;
    }
    try {
        const res = await apiRequest('GET', 'Sessions');
        queueSessions(await res.json());
        sessionQueue = sessionQueue
            .then(() => cleanupDevices())
            .catch(err => adapter.log.warn(`Error during device cleanup: ${err.message}`));
    } catch (e) {
        adapter.log[quiet ? 'debug' : 'warn'](`Could not read sessions: ${e.message}`);
    }
}

/**
 * Reads the device ids registered on the server (Dashboard > Devices).
 *
 * @returns {Promise<Set<string> | null>} device ids, null if unknown (request failed or empty list)
 */
async function getRegisteredDeviceIds() {
    try {
        const res = await apiRequest('GET', 'Devices');
        const data = await res.json();
        const items = Array.isArray(data) ? data : data && Array.isArray(data.Items) ? data.Items : [];
        const ids = new Set();
        for (const item of items) {
            // Emby: ReportedDeviceId = DeviceId of the session, Id = internal number; Jellyfin: Id
            for (const id of [item.ReportedDeviceId, item.Id]) {
                if (id !== undefined && id !== null && id !== '') {
                    ids.add(String(id));
                }
            }
        }
        // an empty list is treated as unknown so a server problem can never wipe all devices
        return ids.size > 0 ? ids : null;
    } catch (e) {
        adapter.log.debug(`Could not read devices: ${e.message}`);
        return null;
    }
}

/**
 * Removes the objects of inactive clients according to the cleanup settings:
 * clients deleted in the Emby dashboard and/or clients without activity for the configured days.
 * Sessions the server currently reports are never touched.
 */
async function cleanupDevices() {
    const removeDeleted = adapter.config.removeDeletedDevices !== false;
    const days = Number(adapter.config.removeInactiveDays) || 0;
    if (!removeDeleted && days <= 0) {
        return;
    }
    const registered = removeDeleted ? await getRegisteredDeviceIds() : null;
    const view = await adapter.getObjectViewAsync('system', 'device', {
        startkey: `${adapter.namespace}.`,
        endkey: `${adapter.namespace}.\u9999`,
    });
    for (const row of view.rows) {
        const sid = row.id.substring(adapter.namespace.length + 1);
        if (activeSessions.has(sid)) {
            continue;
        }
        const deviceId = row.value && row.value.native ? row.value.native.deviceId : '';
        const name = row.value && row.value.common ? row.value.common.name : sid;
        let reason = '';
        if (registered && deviceId && !registered.has(deviceId)) {
            reason = 'it was removed in Emby';
        } else if (days > 0) {
            const last = await getLastActivity(sid);
            if (last > 0 && Date.now() - last > days * DAY_MS) {
                reason = `it was inactive for more than ${days} days`;
            }
        }
        if (reason) {
            adapter.log.info(`Removing objects of client "${name}" (${sid}) because ${reason}`);
            await deleteSessionObjects(sid);
        }
    }
}

/**
 * Time of the last activity of a session from its states.
 *
 * @param {string} sid session id
 * @returns {Promise<number>} timestamp in ms, 0 if unknown
 */
async function getLastActivity(sid) {
    const last = await adapter.getStateAsync(`${sid}.info.lastActivity`);
    if (last && typeof last.val === 'number' && last.val > 0) {
        return last.val;
    }
    // objects of older versions: time the session went offline
    const online = await adapter.getStateAsync(`${sid}.info.online`);
    return online && online.val === false ? online.lc || online.ts || 0 : 0;
}

/**
 * Forgets sessions whose objects were deleted (e.g. by the user in admin), so they are
 * recreated completely on the next update instead of writing states without objects.
 *
 * @param {string} id full object id
 * @param {ioBroker.Object | null | undefined} obj new object, null if deleted
 */
function onObjectChange(id, obj) {
    if (obj || !id.startsWith(`${adapter.namespace}.`)) {
        return;
    }
    const sid = id.substring(adapter.namespace.length + 1).split('.')[0];
    if (sid === 'info') {
        return;
    }
    if (createdSessions.delete(sid)) {
        adapter.log.debug(`Objects of session ${sid} were deleted`);
    }
    // a deleted session that is no longer active must not be recreated by markSessionOffline
    activeSessions.delete(sid);
    delete laststates[sid];
}

/**
 * Handles commands written by the user.
 *
 * @param {string} id full state id
 * @param {ioBroker.State | null | undefined} state new state
 */
function onStateChange(id, state) {
    if (!id || !state || state.ack) {
        return;
    }
    handleCommand(id.substring(adapter.namespace.length + 1), state).catch(e =>
        adapter.log.warn(`Command ${id} failed: ${e.message}`),
    );
}

/**
 * Executes a command for a session.
 *
 * @param {string} id state id without namespace
 * @param {ioBroker.State} state new state
 */
async function handleCommand(id, state) {
    if (id.startsWith('info.') || id.includes('.info.') || id.includes('.media.') || id.includes('.posters.')) {
        // read-only data written by the user: confirm the value as before
        await adapter.setStateAsync(id, state.val, true);
        return;
    }

    const sessionId = id.substring(0, id.indexOf('.'));
    const cmd = id.substring(sessionId.length + 1);
    if (!sessionId || !cmd.startsWith('command.')) {
        adapter.log.info(`Not supported command: ${id}`);
        return;
    }
    if (!apiKey) {
        adapter.log.warn('No API key configured, commands cannot be sent.');
        return;
    }
    const base = `Sessions/${encodeURIComponent(sessionId)}`;

    if (SIMPLE_COMMANDS[cmd]) {
        await apiPost(`${base}/${SIMPLE_COMMANDS[cmd]}`);
        await adapter.setStateAsync(id, state.val, true);
        return;
    }

    const text = state.val === null || state.val === undefined ? '' : String(state.val);
    switch (cmd) {
        case 'command.message':
            await apiPost(`${base}/Message`, { Header: 'ioBroker', Text: text, TimeoutMs: 5000 });
            await adapter.setStateAsync(id, '', true);
            break;

        case 'command.dialog': {
            const sep = text.indexOf('|');
            const body =
                sep !== -1
                    ? { Header: text.substring(0, sep), Text: text.substring(sep + 1) }
                    : { Header: 'ioBroker', Text: text };
            await apiPost(`${base}/Message`, body);
            await adapter.setStateAsync(id, '', true);
            break;
        }

        case 'command.volume': {
            const volume = Math.round(Number(state.val));
            if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
                adapter.log.warn(`Invalid volume "${state.val}", expected 0-100`);
                return;
            }
            await apiPost(`${base}/Command`, { Name: 'SetVolume', Arguments: { Volume: String(volume) } });
            await adapter.setStateAsync(id, volume, true);
            break;
        }

        default:
            adapter.log.info(`Not supported command: ${cmd} | ${id}`);
            break;
    }
}

/**
 * Converts a plain-text API key stored by older versions into an encrypted value.
 *
 * @returns {Promise<boolean>} true if the instance object was rewritten
 */
async function migratePlainApiKey() {
    // @KI_HINWEIS: Since `apikey` is listed in encryptedNative, js-controller decrypts it on start.
    // Values without the `$/aes-192-cbc:` prefix are treated as legacy (XOR) encrypted, so a key that
    // versions <= 1.3.0 stored in plain text arrives as garbage in adapter.config. Emby/Jellyfin API keys
    // are 32 hex characters; a raw value of exactly that form is plain text and gets encrypted once.
    // Anything else (aes or real legacy encryption) is left alone and adapter.config is trusted.
    const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
    const raw = obj && obj.native ? obj.native.apikey : '';
    if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/i.test(raw)) {
        return false;
    }
    adapter.log.info('Encrypting API key stored in plain text by an older version.');
    apiKey = raw;
    // updateConfig() encrypts all encryptedNative attributes itself
    await adapter.updateConfig({ apikey: raw });
    return true;
}

/** Adapter start. */
async function main() {
    await adapter.setStateAsync('info.connection', false, true);

    // the key is copied once, adapter.config.apikey is not read again (see migratePlainApiKey)
    apiKey = adapter.config.apikey || '';
    await migratePlainApiKey();
    if (!adapter.config.ip || adapter.config.ip === '0.0.0.0:8096') {
        adapter.log.error('No server address configured (IP:Port).');
        return;
    }
    if (!apiKey) {
        adapter.log.warn('There is no ApiKey. You can receive information but cannot control clients.');
    }

    adapter.subscribeStates('*');
    adapter.subscribeObjects('*');
    tryConnect();
    startPolling();
}

/**
 * Starts the periodic REST poll of the sessions and the device cleanup.
 */
function startPolling() {
    // undefined for instances created by older versions: use the defaults from io-package
    const seconds = adapter.config.pollInterval === undefined ? 60 : Number(adapter.config.pollInterval) || 0;
    if (seconds <= 0 || !apiKey) {
        return;
    }
    // @KI_HINWEIS: Emby pushes "Sessions" only on changes (start, stop, pause). The poll keeps
    // info.lastActivity current, catches missed pushes and drives the optional device cleanup.
    pollTimer = adapter.setInterval(
        () => {
            if (connection && connection.readyState === WebSocket.OPEN) {
                void refreshSessions(true);
            }
        },
        Math.max(MIN_POLL_SECONDS, seconds) * 1000,
    );
}

/**
 * Device id the adapter uses towards the server. Stable per instance so it does not
 * register as a new device on every start and does not collide with other installations.
 *
 * @returns {string} device id
 */
function ownDeviceId() {
    return `ioBroker-${adapter.namespace}`;
}

/** Opens the WebSocket connection. Reconnects are scheduled from the close handler only. */
function tryConnect() {
    retryTimer = null;
    if (stopping) {
        return;
    }
    const prefix = adapter.config.isSSL ? 'wss://' : 'ws://';
    const url = `${prefix}${adapter.config.ip}?api_key=${encodeURIComponent(apiKey)}&deviceId=${encodeURIComponent(ownDeviceId())}`;
    adapter.log.debug(`try to connect to: ${adapter.config.ip}`);

    try {
        connection = new WebSocket(url);
    } catch (e) {
        adapter.log.warn(`Connection could not be established: ${e.message}`);
        scheduleReconnect();
        return;
    }

    connection.onopen = onSocketOpen;
    connection.onmessage = onSocketMessage;
    // WHATWG WebSocket: an error is always followed by a close event, reconnect is handled there
    connection.onerror = event => {
        adapter.log.debug(`WebSocket error: ${event && event.message ? event.message : 'unknown'}`);
    };
    connection.onclose = onSocketClose;
}

/** Schedules exactly one reconnect attempt. */
function scheduleReconnect() {
    if (stopping || retryTimer) {
        return;
    }
    retryTimer = adapter.setTimeout(tryConnect, RECONNECT_DELAY_MS);
}

/** Connection established: subscribe to session updates and start keepalive. */
function onSocketOpen() {
    adapter.log.info(`connected with emby (${adapter.config.ip})`);
    adapter.setState('info.connection', true, true);
    // @KI_HINWEIS: Emby 4.10 pushes "Sessions" only when something changes (the interval in the
    // data is ignored) and does not answer KeepAlive. A "no data" watchdog would therefore reconnect
    // on every quiet server. The periodic KeepAlive keeps traffic on the socket, so a dead TCP
    // connection ends in a close event and the normal reconnect.
    connection.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,10000' }));
    startKeepAlive(DEFAULT_KEEPALIVE_MS);
    // the server sends the first "Sessions" message only after the next change, so read the
    // current state right away (also brings states up to date after a reconnect)
    void refreshSessions();
}

/**
 * Socket closed (server restart, network loss, idle timeout).
 *
 * @param {{code?: number, reason?: string}} event close event
 */
function onSocketClose(event) {
    if (keepAliveTimer) {
        adapter.clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    connection = null;
    if (stopping) {
        return;
    }
    adapter.setState('info.connection', false, true);
    adapter.log.warn(
        `Connection to emby closed (code ${event && event.code}${event && event.reason ? `, ${event.reason}` : ''}). Reconnect in ${RECONNECT_DELAY_MS / 1000}s`,
    );
    scheduleReconnect();
}

/**
 * Sends KeepAlive messages in the given interval.
 *
 * @param {number} intervalMs interval in milliseconds
 */
function startKeepAlive(intervalMs) {
    if (keepAliveTimer) {
        adapter.clearInterval(keepAliveTimer);
    }
    keepAliveTimer = adapter.setInterval(() => {
        if (connection && connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify({ MessageType: 'KeepAlive' }));
        }
    }, intervalMs);
}

/**
 * Dispatches incoming WebSocket messages by MessageType.
 *
 * @param {{data: string}} e message event
 */
function onSocketMessage(e) {
    let msg;
    try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
    } catch {
        adapter.log.debug(`Ignoring non-JSON message: ${String(e.data).substring(0, 200)}`);
        return;
    }
    adapter.log.silly(JSON.stringify(msg));

    switch (msg && msg.MessageType) {
        case 'Sessions':
            queueSessions(msg.Data);
            break;
        case 'ForceKeepAlive': {
            // Data = timeout in seconds after which the server drops the connection; answer at half of it
            const seconds = Number(msg.Data);
            if (Number.isFinite(seconds) && seconds > 0) {
                startKeepAlive(Math.max(5_000, (seconds * 1000) / 2));
            }
            if (connection && connection.readyState === WebSocket.OPEN) {
                connection.send(JSON.stringify({ MessageType: 'KeepAlive' }));
            }
            break;
        }
        case 'KeepAlive':
            break;
        case 'ServerRestarting':
        case 'ServerShuttingDown':
            adapter.log.info(`Server message: ${msg.MessageType}`);
            break;
        default:
            adapter.log.debug(`Unhandled message type: ${msg && msg.MessageType}`);
            break;
    }
}

/**
 * Returns true if a session should be skipped according to the ignore list (comma separated
 * session ids or device ids, exact match).
 *
 * @param {object} d session from the server
 * @returns {boolean} true if ignored
 */
function isIgnored(d) {
    const list = String(adapter.config.deviceIds || '')
        .split(/[\s,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
    return list.includes(d.Id) || (d.DeviceId && list.includes(d.DeviceId));
}

/**
 * Writes a state only if its value changed.
 *
 * @param {string} id state id below the namespace
 * @param {ioBroker.StateValue} val value
 */
async function setValue(id, val) {
    await adapter.setStateChangedAsync(id, { val, ack: true });
}

/**
 * Processes a Sessions message: updates all reported sessions and marks sessions that are no
 * longer reported as offline.
 *
 * @param {object[]} list sessions
 */
async function handleSessions(list) {
    if (!initialSessionsLoaded) {
        // sessions left over from before an adapter restart are marked offline on the first message
        const view = await adapter.getObjectViewAsync('system', 'device', {
            startkey: `${adapter.namespace}.`,
            endkey: `${adapter.namespace}.\u9999`,
        });
        for (const row of view.rows) {
            activeSessions.add(row.id.substring(adapter.namespace.length + 1));
        }
        initialSessionsLoaded = true;
    }
    const seen = new Set();

    for (const d of list) {
        if (!d || typeof d.Id !== 'string' || d.Id === '') {
            continue;
        }
        if (d.DeviceId === ownDeviceId() || d.DeviceId === '00001') {
            // the adapter's own connection (00001 = fixed id used by versions <= 1.3.0)
            continue;
        }
        if (isIgnored(d)) {
            adapter.log.debug(`Device skipped: ${d.DeviceName}`);
            continue;
        }
        seen.add(d.Id);
        // @KI_HINWEIS: a web client reports SupportsRemoteControl=false while its page is in the
        // background or reconnecting, so the objects are rebuilt whenever this signature changes.
        const signature = JSON.stringify([d.DeviceName, !!d.SupportsRemoteControl, d.SupportedCommands || []]);
        if (createdSessions.get(d.Id) !== signature) {
            await createDevice(d);
            createdSessions.set(d.Id, signature);
        }
        await updateSession(d);
    }

    for (const id of activeSessions) {
        if (!seen.has(id)) {
            await markSessionOffline(id);
        }
    }
    activeSessions = seen;
}

/**
 * Formats the expected end time as HH:MM.
 *
 * @param {number} msFromNow remaining playback time in ms
 * @returns {string} end time
 */
function formatEndTime(msFromNow) {
    const end = new Date(Date.now() + msFromNow);
    return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

/**
 * Updates the states of one session.
 *
 * @param {object} d session from the server
 */
async function updateSession(d) {
    const sid = d.Id;
    await setValue(`${sid}.info.online`, true);
    await setValue(`${sid}.info.deviceName`, d.DeviceName || '');
    await setValue(`${sid}.info.userName`, d.UserName || '');
    if (Array.isArray(d.SupportedCommands)) {
        await setValue(`${sid}.info.supportedCommands`, JSON.stringify(d.SupportedCommands));
    }
    const lastActivity = Date.parse(d.LastActivityDate);
    if (Number.isFinite(lastActivity)) {
        await setValue(`${sid}.info.lastActivity`, lastActivity);
    }

    const npi = d.NowPlayingItem;
    const ps = d.PlayState || {};
    if (!npi) {
        await clearMedia(sid);
        changeState(sid, 'idle');
        return;
    }

    const str = v => (v === undefined || v === null ? '' : String(v));
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const list = v => (Array.isArray(v) ? v.join(',') : '');

    await setValue(
        `${sid}.media.endtime`,
        typeof npi.RunTimeTicks === 'number' && typeof ps.PositionTicks === 'number'
            ? formatEndTime((npi.RunTimeTicks - ps.PositionTicks) / 10000)
            : '',
    );
    await setValue(`${sid}.media.title`, str(npi.Name));
    await setValue(`${sid}.media.description`, str(npi.Overview));
    await setValue(`${sid}.media.type`, str(npi.Type));
    await setValue(`${sid}.media.rating`, num(npi.CommunityRating));
    await setValue(`${sid}.media.year`, num(npi.ProductionYear));
    await setValue(`${sid}.media.tags`, list(npi.Taglines));
    await setValue(`${sid}.media.genres`, list(npi.Genres));
    await setValue(`${sid}.media.backdropimage`, list(npi.BackdropImageTags));
    await setValue(`${sid}.media.ratio`, num(npi.PrimaryImageAspectRatio));
    await setValue(`${sid}.media.agerating`, str(npi.OfficialRating));
    await setValue(`${sid}.media.originaltitle`, str(npi.OriginalTitle));
    await setValue(`${sid}.media.seasonName`, str(npi.SeasonName));
    await setValue(`${sid}.media.seriesName`, npi.SeasonName !== undefined ? str(npi.SeriesName) : '');
    await setValue(`${sid}.media.isMuted`, ps.IsMuted === true);
    if (
        typeof ps.VolumeLevel === 'number' &&
        d.SupportsRemoteControl &&
        Array.isArray(d.SupportedCommands) &&
        d.SupportedCommands.includes('SetVolume')
    ) {
        await setValue(`${sid}.command.volume`, ps.VolumeLevel);
    }

    const basePoster = `${baseUrl()}/Items/`;
    let posters = ['', '', ''];
    if (npi.Type === 'Episode') {
        posters = [
            `${basePoster}${npi.SeriesId}/Images/Primary`,
            `${basePoster}${npi.SeasonId}/Images/Primary`,
            `${basePoster}${npi.Id}/Images/Primary`,
        ];
    } else if (npi.Type === 'Movie') {
        posters = [`${basePoster}${npi.Id}/Images/Primary`, '', ''];
    }
    await setValue(`${sid}.posters.main`, posters[0]);
    await setValue(`${sid}.posters.season`, posters[1]);
    await setValue(`${sid}.posters.episode`, posters[2]);

    if (ps.MediaSourceId !== undefined && !ps.IsPaused) {
        changeState(sid, 'playing');
    } else {
        changeState(sid, 'paused');
    }
}

/**
 * Resets all media states of a session.
 *
 * @param {string} sid session id
 */
async function clearMedia(sid) {
    for (const s of [
        'title',
        'description',
        'seasonName',
        'seriesName',
        'endtime',
        'tags',
        'genres',
        'backdropimage',
        'agerating',
        'originaltitle',
    ]) {
        await setValue(`${sid}.media.${s}`, '');
    }
    for (const s of ['rating', 'year', 'ratio']) {
        await setValue(`${sid}.media.${s}`, null);
    }
    await setValue(`${sid}.media.type`, 'None');
    await setValue(`${sid}.media.isMuted`, false);
    for (const s of ['main', 'season', 'episode']) {
        await setValue(`${sid}.posters.${s}`, '');
    }
}

/**
 * Deletes the objects of older sessions of the same client.
 *
 * Emby assigns a new session id whenever a client reconnects, so without this every app restart
 * would leave another device below the adapter namespace. The old objects cannot receive data any
 * more, scripts pointing at them were already broken by the id change.
 *
 * @param {string} sid id of the current session
 * @param {string} deviceId Emby device id of the client
 */
async function removeSupersededSessions(sid, deviceId) {
    const view = await adapter.getObjectViewAsync('system', 'device', {
        startkey: `${adapter.namespace}.`,
        endkey: `${adapter.namespace}.\u9999`,
    });
    for (const row of view.rows) {
        const oldSid = row.id.substring(adapter.namespace.length + 1);
        if (oldSid === sid || !row.value || !row.value.native || row.value.native.deviceId !== deviceId) {
            continue;
        }
        adapter.log.info(
            `Removing objects of old session ${oldSid}, client "${row.value.common.name}" now uses ${sid}`,
        );
        await deleteSessionObjects(oldSid);
    }
}

/**
 * Deletes all objects of a session and forgets its runtime state.
 *
 * @param {string} sid session id
 */
async function deleteSessionObjects(sid) {
    activeSessions.delete(sid);
    createdSessions.delete(sid);
    if (timeoutplays[sid]) {
        adapter.clearTimeout(timeoutplays[sid]);
    }
    delete timeoutplays[sid];
    delete timeoutstates[sid];
    delete timeoutstarted[sid];
    delete laststates[sid];
    await adapter.delObjectAsync(sid, { recursive: true });
}

/**
 * Marks a session the server no longer reports (client closed, TV switched off).
 *
 * @param {string} sid session id
 */
async function markSessionOffline(sid) {
    if (!(await adapter.getObjectAsync(sid))) {
        // objects were deleted in the meantime, nothing to update
        return;
    }
    adapter.log.debug(`Session ${sid} is no longer active`);
    // objects created by versions <= 1.3.0 have no info.online yet
    await adapter.extendObjectAsync(
        `${sid}.info.online`,
        roState('Session is active on the server', 'boolean', 'indicator.reachable'),
    );
    await setValue(`${sid}.info.online`, false);
    await clearMedia(sid);
    changeState(sid, 'idle');
}

/**
 * Sets media.state; changes away from "playing" are delayed by the configured timeout
 * to suppress short flickering.
 *
 * @param {string} id session id
 * @param {string} state idle | paused | playing
 */
function changeState(id, state) {
    if (laststates[id] === state) {
        return;
    }

    if (state === 'playing') {
        if (timeoutplays[id]) {
            adapter.clearTimeout(timeoutplays[id]);
            timeoutplays[id] = null;
        }
        timeoutstarted[id] = false;
        adapter.setState(`${id}.media.state`, state, true);
    } else {
        timeoutstates[id] = state;
        if (!timeoutstarted[id]) {
            timeoutstarted[id] = true;
            timeoutplays[id] = adapter.setTimeout(
                () => {
                    timeoutplays[id] = null;
                    timeoutstarted[id] = false;
                    adapter.setState(`${id}.media.state`, timeoutstates[id], true);
                },
                Number(adapter.config.timeout) || 0,
            );
        }
    }

    laststates[id] = state;
}

/**
 * Builds a read-only state definition.
 *
 * @param {string} name name
 * @param {string} type common.type
 * @param {string} [role] role
 * @returns {ioBroker.SettableStateObject} object
 */
function roState(name, type, role = 'state') {
    return { type: 'state', common: { name, role, type, read: true, write: false }, native: {} };
}

/**
 * Builds a button definition.
 *
 * @param {string} name name
 * @returns {ioBroker.SettableStateObject} object
 */
function button(name) {
    return { type: 'state', common: { name, role: 'button', type: 'boolean', read: false, write: true }, native: {} };
}

/**
 * Creates or updates the objects of a session. Uses extendObject so objects created by older
 * versions with invalid types (e.g. common.type "button") are corrected.
 *
 * @param {object} device session from the server
 */
async function createDevice(device) {
    const sid = device.Id;
    await adapter.setObjectNotExistsAsync(sid, {
        type: 'device',
        common: { name: device.DeviceName || sid },
        native: {},
    });
    // the display name can be changed in the Emby dashboard (Devices), keep it in sync
    await adapter.extendObjectAsync(sid, {
        common: { name: device.DeviceName || sid },
        native: { deviceId: device.DeviceId || '' },
    });
    if (device.DeviceId) {
        await removeSupersededSessions(sid, device.DeviceId);
    }

    // Record<string, ioBroker.SettableObject>
    const objs = {
        info: { type: 'channel', common: { name: 'Info' }, native: {} },
        media: { type: 'channel', common: { name: 'Media Info' }, native: {} },
        posters: { type: 'channel', common: { name: 'Media Posters' }, native: {} },
        'info.online': roState('Session is active on the server', 'boolean', 'indicator.reachable'),
        'info.deviceName': roState('Name of the Device now playing', 'string', 'info.name'),
        'info.userName': roState('Logged in User', 'string', 'info.name'),
        'info.supportedCommands': roState('List of supported Commands', 'string', 'json'),
        'info.lastActivity': roState('Last activity of the client', 'number', 'date'),
        'media.state': {
            type: 'state',
            common: {
                name: 'State of the Client',
                role: 'media.state',
                type: 'string',
                read: true,
                write: false,
                states: { idle: 'Idle', paused: 'Paused', playing: 'Playing' },
            },
            native: {},
        },
        'media.isMuted': roState('If Player is muted', 'boolean', 'media.mute'),
        'media.title': roState('Title of file playing', 'string', 'media.title'),
        'media.seriesName': roState('Name of serie now playing', 'string', 'media.title'),
        'media.seasonName': roState('Name of season now playing', 'string', 'media.season'),
        'media.type': roState('Type of file playing', 'string'),
        'media.description': roState('Description of file playing', 'string'),
        'media.endtime': roState('Endtime of playing video/audio', 'string'),
        'media.rating': roState('Community Rating', 'number'),
        'media.year': roState('Production Year', 'number'),
        'media.tags': roState('Tags', 'string'),
        'media.genres': roState('Genres', 'string'),
        'media.backdropimage': roState('BackdropImageTags', 'string'),
        'media.ratio': roState('Ratio', 'number'),
        'media.agerating': roState('Age Rating', 'string'),
        'media.originaltitle': roState('Original Title', 'string'),
        'posters.main': roState('Main Poster', 'string', 'url'),
        'posters.episode': roState('Episode Poster', 'string', 'url'),
        'posters.season': roState('Season Poster', 'string', 'url'),
    };

    if (device.SupportsRemoteControl) {
        objs.command = { type: 'channel', common: { name: 'Control Client' }, native: {} };
        objs['command.pause'] = button('Pause');
        objs['command.play'] = button('Play');
        objs['command.toggleplay'] = button('Toggle Play');

        const supported = Array.isArray(device.SupportedCommands) ? device.SupportedCommands : [];
        for (const c of supported) {
            switch (c) {
                case 'DisplayMessage':
                    objs['command.message'] = {
                        type: 'state',
                        common: { name: 'Message', role: 'text', type: 'string', read: false, write: true },
                        native: {},
                    };
                    objs['command.dialog'] = {
                        type: 'state',
                        common: { name: 'Message Dialog', role: 'text', type: 'string', read: false, write: true },
                        native: {},
                    };
                    break;
                case 'GoHome':
                    objs['command.goHome'] = button('GoHome');
                    break;
                case 'SetVolume':
                    objs['command.volume'] = {
                        type: 'state',
                        common: {
                            name: 'Set Volume (causes crash on some devices)',
                            role: 'level.volume',
                            type: 'number',
                            min: 0,
                            max: 100,
                            read: true,
                            write: true,
                        },
                        native: {},
                    };
                    break;
                case 'GoToSearch':
                    objs['command.goToSearch'] = button('Go to search');
                    break;
                case 'Back':
                    objs['command.back'] = button('Back');
                    break;
                case 'Mute':
                    objs['command.mute'] = button('Mute');
                    break;
                case 'Unmute':
                case 'UnMute':
                    objs['command.unmute'] = button('Unmute');
                    break;
                case 'ToggleMute':
                    objs['command.togglemute'] = button('Toggle Mute');
                    break;
            }
        }
    }

    for (const [id, obj] of Object.entries(objs)) {
        await adapter.extendObjectAsync(`${sid}.${id}`, obj);
    }
}

if (require.main !== module) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
