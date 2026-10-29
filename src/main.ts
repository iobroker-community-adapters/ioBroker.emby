import * as utils from '@iobroker/adapter-core';

import type { EmbyDevicesResponse, EmbySession, EmbySocketMessage } from './lib/types';

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
const SIMPLE_COMMANDS: Record<string, string> = {
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

type MediaState = 'idle' | 'paused' | 'playing';

/**
 * Builds a read-only state definition.
 *
 * @param name name
 * @param type common.type
 * @param role role
 */
function roState(name: string, type: ioBroker.CommonType, role = 'state'): ioBroker.SettableStateObject {
    return { type: 'state', common: { name, role, type, read: true, write: false }, native: {} };
}

/**
 * Builds a button definition.
 *
 * @param name name
 */
function button(name: string): ioBroker.SettableStateObject {
    return { type: 'state', common: { name, role: 'button', type: 'boolean', read: false, write: true }, native: {} };
}

/**
 * Object name for log messages. The adapter writes plain strings, but common.name may be translated.
 *
 * @param name common.name
 */
function nameOf(name: ioBroker.StringOrTranslated): string {
    return typeof name === 'string' ? name : JSON.stringify(name);
}

/**
 * Formats the expected end time as HH:MM.
 *
 * @param msFromNow remaining playback time in ms
 */
function formatEndTime(msFromNow: number): string {
    const end = new Date(Date.now() + msFromNow);
    return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

class EmbyAdapter extends utils.Adapter {
    private connection: WebSocket | null = null;
    private stopping = false;
    private retryTimer: ioBroker.Timeout | undefined | null = null;
    private keepAliveTimer: ioBroker.Interval | undefined | null = null;
    private pollTimer: ioBroker.Interval | undefined | null = null;
    /** Serialises processing of Sessions messages so slow object creation cannot overlap. */
    private sessionQueue: Promise<void> = Promise.resolve();

    /** Session id → signature (name, remote control, supported commands) of the objects created during this run. */
    private readonly createdSessions = new Map<string, string>();
    /** Session ids reported by the server in the last Sessions message. */
    private activeSessions = new Set<string>();
    private initialSessionsLoaded = false;
    /** API key, resolved once at start (see migratePlainApiKey). */
    private apiKey = '';

    private readonly laststates: Record<string, MediaState> = {};
    private readonly timeoutplays: Record<string, ioBroker.Timeout | undefined | null> = {};
    private readonly timeoutstates: Record<string, MediaState> = {};
    private readonly timeoutstarted: Record<string, boolean> = {};

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'emby' });

        this.on('ready', () => {
            this.onReady().catch(e => this.log.error(`Startup failed: ${(e as Error).message}`));
        });
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('objectChange', (id, obj) => this.onObjectChange(id, obj));
        this.on('unload', callback => this.onUnload(callback));
    }

    /** Adapter start. */
    private async onReady(): Promise<void> {
        await this.setStateAsync('info.connection', false, true);

        // the key is copied once, this.config.apikey is not read again (see migratePlainApiKey)
        this.apiKey = this.config.apikey || '';
        await this.migratePlainApiKey();
        if (!this.config.ip || this.config.ip === '0.0.0.0:8096') {
            this.log.error('No server address configured (IP:Port).');
            return;
        }
        if (!this.apiKey) {
            this.log.warn('There is no ApiKey. You can receive information but cannot control clients.');
        }

        this.subscribeStates('*');
        this.subscribeObjects('*');
        this.tryConnect();
        this.startPolling();
    }

    /**
     * Called when the adapter shuts down. The callback has to be called under any circumstances.
     *
     * @param callback done callback
     */
    private onUnload(callback: () => void): void {
        this.stopping = true;
        try {
            this.stopTimers();
            Object.keys(this.timeoutplays).forEach(id => this.clearTimeout(this.timeoutplays[id]));
            if (this.connection) {
                if (this.connection.readyState === WebSocket.OPEN) {
                    this.connection.send(JSON.stringify({ MessageType: 'SessionsStop', Data: '' }));
                }
                this.connection.close();
                this.connection = null;
            }
            void this.setState('info.connection', false, true);
        } catch {
            // ignore, we are shutting down anyway
        } finally {
            callback();
        }
    }

    /** Stops reconnect, keepalive and poll timers. */
    private stopTimers(): void {
        if (this.retryTimer) {
            this.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.keepAliveTimer) {
            this.clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.pollTimer) {
            this.clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Base URL of the server for REST calls (honours the SSL option), e.g. http://192.168.0.100:8096 */
    private baseUrl(): string {
        return `${this.config.isSSL ? 'https' : 'http'}://${this.config.ip}`;
    }

    /**
     * Sends a request to the server. The API key is sent as header, never in the URL,
     * so it cannot end up in logs.
     *
     * @param method HTTP method
     * @param path path below the server root, e.g. `Sessions/<id>/Playing/Pause`
     * @param body JSON body
     * @returns response (status 2xx)
     */
    private async apiRequest(method: 'GET' | 'POST', path: string, body?: object): Promise<Response> {
        const res = await fetch(`${this.baseUrl()}/${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': this.apiKey,
                // same DeviceId as the WebSocket, otherwise the server registers every REST call as an extra client
                'X-Emby-Authorization': `MediaBrowser Client="ioBroker", Device="ioBroker", DeviceId="${this.ownDeviceId()}", Version="${this.version}"`,
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
     * @param path path below the server root
     * @param body JSON body
     */
    private async apiPost(path: string, body?: object): Promise<void> {
        await this.apiRequest('POST', path, body);
    }

    /**
     * Queues a list of sessions for processing (WebSocket push or REST poll).
     *
     * @param data session list
     */
    private queueSessions(data: unknown): void {
        const list = Array.isArray(data) ? (data as EmbySession[]) : [];
        this.sessionQueue = this.sessionQueue
            .then(() => this.handleSessions(list))
            .catch(err => this.log.warn(`Error processing sessions: ${(err as Error).message}`));
    }

    /**
     * Reads the current sessions via REST and runs the device cleanup afterwards. Needs an API key.
     *
     * @param quiet log failures only on debug level (periodic poll)
     */
    private async refreshSessions(quiet = false): Promise<void> {
        if (!this.apiKey) {
            return;
        }
        try {
            const res = await this.apiRequest('GET', 'Sessions');
            this.queueSessions(await res.json());
            this.sessionQueue = this.sessionQueue
                .then(() => this.cleanupDevices())
                .catch(err => this.log.warn(`Error during device cleanup: ${(err as Error).message}`));
        } catch (e) {
            this.log[quiet ? 'debug' : 'warn'](`Could not read sessions: ${(e as Error).message}`);
        }
    }

    /**
     * Reads the device ids registered on the server (Dashboard > Devices).
     *
     * @returns device ids, null if unknown (request failed or empty list)
     */
    private async getRegisteredDeviceIds(): Promise<Set<string> | null> {
        try {
            const res = await this.apiRequest('GET', 'Devices');
            const data = (await res.json()) as EmbyDevicesResponse;
            const items = Array.isArray(data) ? data : data && Array.isArray(data.Items) ? data.Items : [];
            const ids = new Set<string>();
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
            this.log.debug(`Could not read devices: ${(e as Error).message}`);
            return null;
        }
    }

    /** Device objects of all sessions below the adapter namespace. */
    private async getSessionDevices(): Promise<{ sid: string; obj: ioBroker.DeviceObject | undefined }[]> {
        const view = await this.getObjectViewAsync('system', 'device', {
            startkey: `${this.namespace}.`,
            endkey: `${this.namespace}.香`,
        });
        return view.rows.map(row => ({ sid: row.id.substring(this.namespace.length + 1), obj: row.value }));
    }

    /**
     * Removes the objects of inactive clients according to the cleanup settings:
     * clients deleted in the Emby dashboard and/or clients without activity for the configured days.
     * Sessions the server currently reports are never touched.
     */
    private async cleanupDevices(): Promise<void> {
        const removeDeleted = this.config.removeDeletedDevices !== false;
        const days = Number(this.config.removeInactiveDays) || 0;
        if (!removeDeleted && days <= 0) {
            return;
        }
        const registered = removeDeleted ? await this.getRegisteredDeviceIds() : null;
        for (const { sid, obj } of await this.getSessionDevices()) {
            if (this.activeSessions.has(sid)) {
                continue;
            }
            const deviceId: string = obj?.native?.deviceId || '';
            const name: ioBroker.StringOrTranslated = obj?.common ? obj.common.name : sid;
            let reason = '';
            if (registered && deviceId && !registered.has(deviceId)) {
                reason = 'it was removed in Emby';
            } else if (days > 0) {
                const last = await this.getLastActivity(sid);
                if (last > 0 && Date.now() - last > days * DAY_MS) {
                    reason = `it was inactive for more than ${days} days`;
                }
            }
            if (reason) {
                this.log.info(`Removing objects of client "${nameOf(name)}" (${sid}) because ${reason}`);
                await this.deleteSessionObjects(sid);
            }
        }
    }

    /**
     * Time of the last activity of a session from its states.
     *
     * @param sid session id
     * @returns timestamp in ms, 0 if unknown
     */
    private async getLastActivity(sid: string): Promise<number> {
        const last = await this.getStateAsync(`${sid}.info.lastActivity`);
        if (last && typeof last.val === 'number' && last.val > 0) {
            return last.val;
        }
        // objects of older versions: time the session went offline
        const online = await this.getStateAsync(`${sid}.info.online`);
        return online && online.val === false ? online.lc || online.ts || 0 : 0;
    }

    /**
     * Forgets sessions whose objects were deleted (e.g. by the user in admin), so they are
     * recreated completely on the next update instead of writing states without objects.
     *
     * @param id full object id
     * @param obj new object, null if deleted
     */
    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (obj || !id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const sid = id.substring(this.namespace.length + 1).split('.')[0];
        if (sid === 'info') {
            return;
        }
        if (this.createdSessions.delete(sid)) {
            this.log.debug(`Objects of session ${sid} were deleted`);
        }
        // a deleted session that is no longer active must not be recreated by markSessionOffline
        this.activeSessions.delete(sid);
        delete this.laststates[sid];
    }

    /**
     * Handles commands written by the user.
     *
     * @param id full state id
     * @param state new state
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!id || !state || state.ack) {
            return;
        }
        this.handleCommand(id.substring(this.namespace.length + 1), state).catch(e =>
            this.log.warn(`Command ${id} failed: ${(e as Error).message}`),
        );
    }

    /**
     * Executes a command for a session.
     *
     * @param id state id without namespace
     * @param state new state
     */
    private async handleCommand(id: string, state: ioBroker.State): Promise<void> {
        if (id.startsWith('info.') || id.includes('.info.') || id.includes('.media.') || id.includes('.posters.')) {
            // read-only data written by the user: confirm the value as before
            await this.setStateAsync(id, state.val, true);
            return;
        }

        const sessionId = id.substring(0, id.indexOf('.'));
        const cmd = id.substring(sessionId.length + 1);
        if (!sessionId || !cmd.startsWith('command.')) {
            this.log.info(`Not supported command: ${id}`);
            return;
        }
        if (!this.apiKey) {
            this.log.warn('No API key configured, commands cannot be sent.');
            return;
        }
        const base = `Sessions/${encodeURIComponent(sessionId)}`;

        if (SIMPLE_COMMANDS[cmd]) {
            await this.apiPost(`${base}/${SIMPLE_COMMANDS[cmd]}`);
            await this.setStateAsync(id, state.val, true);
            return;
        }

        const text = state.val === null || state.val === undefined ? '' : String(state.val);
        switch (cmd) {
            case 'command.message':
                await this.apiPost(`${base}/Message`, { Header: 'ioBroker', Text: text, TimeoutMs: 5000 });
                await this.setStateAsync(id, '', true);
                break;

            case 'command.dialog': {
                const sep = text.indexOf('|');
                const body =
                    sep !== -1
                        ? { Header: text.substring(0, sep), Text: text.substring(sep + 1) }
                        : { Header: 'ioBroker', Text: text };
                await this.apiPost(`${base}/Message`, body);
                await this.setStateAsync(id, '', true);
                break;
            }

            case 'command.volume': {
                const volume = Math.round(Number(state.val));
                if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
                    this.log.warn(`Invalid volume "${String(state.val)}", expected 0-100`);
                    return;
                }
                await this.apiPost(`${base}/Command`, { Name: 'SetVolume', Arguments: { Volume: String(volume) } });
                await this.setStateAsync(id, volume, true);
                break;
            }

            default:
                this.log.info(`Not supported command: ${cmd} | ${id}`);
                break;
        }
    }

    /**
     * Converts a plain-text API key stored by older versions into an encrypted value.
     *
     * @returns true if the instance object was rewritten
     */
    private async migratePlainApiKey(): Promise<boolean> {
        // @KI_HINWEIS: Since `apikey` is listed in encryptedNative, js-controller decrypts it on start.
        // Values without the `$/aes-192-cbc:` prefix are treated as legacy (XOR) encrypted, so a key that
        // versions <= 1.3.0 stored in plain text arrives as garbage in this.config. Emby/Jellyfin API keys
        // are 32 hex characters; a raw value of exactly that form is plain text and gets encrypted once.
        // Anything else (aes or real legacy encryption) is left alone and this.config is trusted.
        const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        const raw: unknown = obj?.native ? obj.native.apikey : '';
        if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/i.test(raw)) {
            return false;
        }
        this.log.info('Encrypting API key stored in plain text by an older version.');
        this.apiKey = raw;
        // updateConfig() encrypts all encryptedNative attributes itself
        await this.updateConfig({ apikey: raw });
        return true;
    }

    /** Starts the periodic REST poll of the sessions and the device cleanup. */
    private startPolling(): void {
        // undefined for instances created by older versions: use the defaults from io-package
        const seconds = this.config.pollInterval === undefined ? 60 : Number(this.config.pollInterval) || 0;
        if (seconds <= 0 || !this.apiKey) {
            return;
        }
        // @KI_HINWEIS: Emby pushes "Sessions" only on changes (start, stop, pause). The poll keeps
        // info.lastActivity current, catches missed pushes and drives the optional device cleanup.
        this.pollTimer = this.setInterval(
            () => {
                if (this.connection && this.connection.readyState === WebSocket.OPEN) {
                    void this.refreshSessions(true);
                }
            },
            Math.max(MIN_POLL_SECONDS, seconds) * 1000,
        );
    }

    /**
     * Device id the adapter uses towards the server. Stable per instance so it does not
     * register as a new device on every start and does not collide with other installations.
     */
    private ownDeviceId(): string {
        return `ioBroker-${this.namespace}`;
    }

    /** Opens the WebSocket connection. Reconnects are scheduled from the close handler only. */
    private tryConnect(): void {
        this.retryTimer = null;
        if (this.stopping) {
            return;
        }
        const prefix = this.config.isSSL ? 'wss://' : 'ws://';
        const url = `${prefix}${this.config.ip}?api_key=${encodeURIComponent(this.apiKey)}&deviceId=${encodeURIComponent(this.ownDeviceId())}`;
        this.log.debug(`try to connect to: ${this.config.ip}`);

        let connection: WebSocket;
        try {
            connection = new WebSocket(url);
        } catch (e) {
            this.log.warn(`Connection could not be established: ${(e as Error).message}`);
            this.scheduleReconnect();
            return;
        }
        this.connection = connection;

        connection.onopen = () => this.onSocketOpen();
        connection.onmessage = event => this.onSocketMessage(event);
        // WHATWG WebSocket: an error is always followed by a close event, reconnect is handled there
        connection.onerror = event => {
            const message = (event as Event & { message?: string }).message;
            this.log.debug(`WebSocket error: ${message || 'unknown'}`);
        };
        connection.onclose = event => this.onSocketClose(event);
    }

    /** Schedules exactly one reconnect attempt. */
    private scheduleReconnect(): void {
        if (this.stopping || this.retryTimer) {
            return;
        }
        this.retryTimer = this.setTimeout(() => this.tryConnect(), RECONNECT_DELAY_MS);
    }

    /** Connection established: subscribe to session updates and start keepalive. */
    private onSocketOpen(): void {
        this.log.info(`connected with emby (${this.config.ip})`);
        void this.setState('info.connection', true, true);
        // @KI_HINWEIS: Emby 4.10 pushes "Sessions" only when something changes (the interval in the
        // data is ignored) and does not answer KeepAlive. A "no data" watchdog would therefore reconnect
        // on every quiet server. The periodic KeepAlive keeps traffic on the socket, so a dead TCP
        // connection ends in a close event and the normal reconnect.
        this.connection?.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,10000' }));
        this.startKeepAlive(DEFAULT_KEEPALIVE_MS);
        // the server sends the first "Sessions" message only after the next change, so read the
        // current state right away (also brings states up to date after a reconnect)
        void this.refreshSessions();
    }

    /**
     * Socket closed (server restart, network loss, idle timeout).
     *
     * @param event close event
     */
    private onSocketClose(event: { code?: number; reason?: string } | undefined): void {
        if (this.keepAliveTimer) {
            this.clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        this.connection = null;
        if (this.stopping) {
            return;
        }
        void this.setState('info.connection', false, true);
        this.log.warn(
            `Connection to emby closed (code ${event?.code}${event?.reason ? `, ${event.reason}` : ''}). Reconnect in ${RECONNECT_DELAY_MS / 1000}s`,
        );
        this.scheduleReconnect();
    }

    /**
     * Sends KeepAlive messages in the given interval.
     *
     * @param intervalMs interval in milliseconds
     */
    private startKeepAlive(intervalMs: number): void {
        if (this.keepAliveTimer) {
            this.clearInterval(this.keepAliveTimer);
        }
        this.keepAliveTimer = this.setInterval(() => {
            if (this.connection && this.connection.readyState === WebSocket.OPEN) {
                this.connection.send(JSON.stringify({ MessageType: 'KeepAlive' }));
            }
        }, intervalMs);
    }

    /**
     * Dispatches incoming WebSocket messages by MessageType.
     *
     * @param e message event
     */
    private onSocketMessage(e: MessageEvent): void {
        let msg: EmbySocketMessage | null;
        try {
            msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)) as EmbySocketMessage | null;
        } catch {
            this.log.debug(`Ignoring non-JSON message: ${String(e.data).substring(0, 200)}`);
            return;
        }
        this.log.silly(JSON.stringify(msg));

        switch (msg?.MessageType) {
            case 'Sessions':
                this.queueSessions(msg.Data);
                break;
            case 'ForceKeepAlive': {
                // Data = timeout in seconds after which the server drops the connection; answer at half of it
                const seconds = Number(msg.Data);
                if (Number.isFinite(seconds) && seconds > 0) {
                    this.startKeepAlive(Math.max(5_000, (seconds * 1000) / 2));
                }
                if (this.connection && this.connection.readyState === WebSocket.OPEN) {
                    this.connection.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                }
                break;
            }
            case 'KeepAlive':
                break;
            case 'ServerRestarting':
            case 'ServerShuttingDown':
                this.log.info(`Server message: ${msg.MessageType}`);
                break;
            default:
                this.log.debug(`Unhandled message type: ${msg?.MessageType}`);
                break;
        }
    }

    /**
     * Returns true if a session should be skipped according to the ignore list (comma separated
     * session ids or device ids, exact match).
     *
     * @param d session from the server
     */
    private isIgnored(d: EmbySession): boolean {
        const list = String(this.config.deviceIds || '')
            .split(/[\s,;]+/)
            .map(s => s.trim())
            .filter(Boolean);
        return list.includes(d.Id) || (!!d.DeviceId && list.includes(d.DeviceId));
    }

    /**
     * Writes a state only if its value changed.
     *
     * @param id state id below the namespace
     * @param val value
     */
    private async setValue(id: string, val: ioBroker.StateValue): Promise<void> {
        await this.setStateChangedAsync(id, { val, ack: true });
    }

    /**
     * Processes a Sessions message: updates all reported sessions and marks sessions that are no
     * longer reported as offline.
     *
     * @param list sessions
     */
    private async handleSessions(list: EmbySession[]): Promise<void> {
        if (!this.initialSessionsLoaded) {
            // sessions left over from before an adapter restart are marked offline on the first message
            for (const { sid } of await this.getSessionDevices()) {
                this.activeSessions.add(sid);
            }
            this.initialSessionsLoaded = true;
        }
        const seen = new Set<string>();

        for (const d of list) {
            if (!d || typeof d.Id !== 'string' || d.Id === '') {
                continue;
            }
            if (d.DeviceId === this.ownDeviceId() || d.DeviceId === '00001') {
                // the adapter's own connection (00001 = fixed id used by versions <= 1.3.0)
                continue;
            }
            if (this.isIgnored(d)) {
                this.log.debug(`Device skipped: ${d.DeviceName}`);
                continue;
            }
            seen.add(d.Id);
            // @KI_HINWEIS: a web client reports SupportsRemoteControl=false while its page is in the
            // background or reconnecting, so the objects are rebuilt whenever this signature changes.
            const signature = JSON.stringify([d.DeviceName, !!d.SupportsRemoteControl, d.SupportedCommands || []]);
            if (this.createdSessions.get(d.Id) !== signature) {
                await this.createSessionObjects(d);
                this.createdSessions.set(d.Id, signature);
            }
            await this.updateSession(d);
        }

        for (const id of this.activeSessions) {
            if (!seen.has(id)) {
                await this.markSessionOffline(id);
            }
        }
        this.activeSessions = seen;
    }

    /**
     * Updates the states of one session.
     *
     * @param d session from the server
     */
    private async updateSession(d: EmbySession): Promise<void> {
        const sid = d.Id;
        await this.setValue(`${sid}.info.online`, true);
        await this.setValue(`${sid}.info.deviceName`, d.DeviceName || '');
        await this.setValue(`${sid}.info.userName`, d.UserName || '');
        if (Array.isArray(d.SupportedCommands)) {
            await this.setValue(`${sid}.info.supportedCommands`, JSON.stringify(d.SupportedCommands));
        }
        const lastActivity = Date.parse(d.LastActivityDate as string);
        if (Number.isFinite(lastActivity)) {
            await this.setValue(`${sid}.info.lastActivity`, lastActivity);
        }

        const npi = d.NowPlayingItem;
        const ps = d.PlayState || {};
        if (!npi) {
            await this.clearMedia(sid);
            this.changeState(sid, 'idle');
            return;
        }

        const str = (v: string | number | null | undefined): string => (v === undefined || v === null ? '' : String(v));
        const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const list = (v: unknown): string => (Array.isArray(v) ? v.join(',') : '');

        await this.setValue(
            `${sid}.media.endtime`,
            typeof npi.RunTimeTicks === 'number' && typeof ps.PositionTicks === 'number'
                ? formatEndTime((npi.RunTimeTicks - ps.PositionTicks) / 10000)
                : '',
        );
        await this.setValue(`${sid}.media.title`, str(npi.Name));
        await this.setValue(`${sid}.media.description`, str(npi.Overview));
        await this.setValue(`${sid}.media.type`, str(npi.Type));
        await this.setValue(`${sid}.media.rating`, num(npi.CommunityRating));
        await this.setValue(`${sid}.media.year`, num(npi.ProductionYear));
        await this.setValue(`${sid}.media.tags`, list(npi.Taglines));
        await this.setValue(`${sid}.media.genres`, list(npi.Genres));
        await this.setValue(`${sid}.media.backdropimage`, list(npi.BackdropImageTags));
        await this.setValue(`${sid}.media.ratio`, num(npi.PrimaryImageAspectRatio));
        await this.setValue(`${sid}.media.agerating`, str(npi.OfficialRating));
        await this.setValue(`${sid}.media.originaltitle`, str(npi.OriginalTitle));
        await this.setValue(`${sid}.media.seasonName`, str(npi.SeasonName));
        await this.setValue(`${sid}.media.seriesName`, npi.SeasonName !== undefined ? str(npi.SeriesName) : '');
        await this.setValue(`${sid}.media.isMuted`, ps.IsMuted === true);
        if (
            typeof ps.VolumeLevel === 'number' &&
            d.SupportsRemoteControl &&
            Array.isArray(d.SupportedCommands) &&
            d.SupportedCommands.includes('SetVolume')
        ) {
            await this.setValue(`${sid}.command.volume`, ps.VolumeLevel);
        }

        const basePoster = `${this.baseUrl()}/Items/`;
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
        await this.setValue(`${sid}.posters.main`, posters[0]);
        await this.setValue(`${sid}.posters.season`, posters[1]);
        await this.setValue(`${sid}.posters.episode`, posters[2]);

        if (ps.MediaSourceId !== undefined && !ps.IsPaused) {
            this.changeState(sid, 'playing');
        } else {
            this.changeState(sid, 'paused');
        }
    }

    /**
     * Resets all media states of a session.
     *
     * @param sid session id
     */
    private async clearMedia(sid: string): Promise<void> {
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
            await this.setValue(`${sid}.media.${s}`, '');
        }
        for (const s of ['rating', 'year', 'ratio']) {
            await this.setValue(`${sid}.media.${s}`, null);
        }
        await this.setValue(`${sid}.media.type`, 'None');
        await this.setValue(`${sid}.media.isMuted`, false);
        for (const s of ['main', 'season', 'episode']) {
            await this.setValue(`${sid}.posters.${s}`, '');
        }
    }

    /**
     * Deletes the objects of older sessions of the same client.
     *
     * Emby assigns a new session id whenever a client reconnects, so without this every app restart
     * would leave another device below the adapter namespace. The old objects cannot receive data any
     * more, scripts pointing at them were already broken by the id change.
     *
     * @param sid id of the current session
     * @param deviceId Emby device id of the client
     */
    private async removeSupersededSessions(sid: string, deviceId: string): Promise<void> {
        for (const { sid: oldSid, obj } of await this.getSessionDevices()) {
            if (oldSid === sid || !obj?.native || obj.native.deviceId !== deviceId) {
                continue;
            }
            this.log.info(
                `Removing objects of old session ${oldSid}, client "${nameOf(obj.common.name)}" now uses ${sid}`,
            );
            await this.deleteSessionObjects(oldSid);
        }
    }

    /**
     * Deletes all objects of a session and forgets its runtime state.
     *
     * @param sid session id
     */
    private async deleteSessionObjects(sid: string): Promise<void> {
        this.activeSessions.delete(sid);
        this.createdSessions.delete(sid);
        if (this.timeoutplays[sid]) {
            this.clearTimeout(this.timeoutplays[sid]);
        }
        delete this.timeoutplays[sid];
        delete this.timeoutstates[sid];
        delete this.timeoutstarted[sid];
        delete this.laststates[sid];
        await this.delObjectAsync(sid, { recursive: true });
    }

    /**
     * Marks a session the server no longer reports (client closed, TV switched off).
     *
     * @param sid session id
     */
    private async markSessionOffline(sid: string): Promise<void> {
        if (!(await this.getObjectAsync(sid))) {
            // objects were deleted in the meantime, nothing to update
            return;
        }
        this.log.debug(`Session ${sid} is no longer active`);
        // objects created by versions <= 1.3.0 have no info.online yet
        await this.extendObjectAsync(
            `${sid}.info.online`,
            roState('Session is active on the server', 'boolean', 'indicator.reachable'),
        );
        await this.setValue(`${sid}.info.online`, false);
        await this.clearMedia(sid);
        this.changeState(sid, 'idle');
    }

    /**
     * Sets media.state; changes away from "playing" are delayed by the configured timeout
     * to suppress short flickering.
     *
     * @param id session id
     * @param state idle | paused | playing
     */
    private changeState(id: string, state: MediaState): void {
        if (this.laststates[id] === state) {
            return;
        }

        if (state === 'playing') {
            if (this.timeoutplays[id]) {
                this.clearTimeout(this.timeoutplays[id]);
                this.timeoutplays[id] = null;
            }
            this.timeoutstarted[id] = false;
            void this.setState(`${id}.media.state`, state, true);
        } else {
            this.timeoutstates[id] = state;
            if (!this.timeoutstarted[id]) {
                this.timeoutstarted[id] = true;
                this.timeoutplays[id] = this.setTimeout(
                    () => {
                        this.timeoutplays[id] = null;
                        this.timeoutstarted[id] = false;
                        void this.setState(`${id}.media.state`, this.timeoutstates[id], true);
                    },
                    Number(this.config.timeout) || 0,
                );
            }
        }

        this.laststates[id] = state;
    }

    /**
     * Creates or updates the objects of a session. Uses extendObject so objects created by older
     * versions with invalid types (e.g. common.type "button") are corrected.
     *
     * @param device session from the server
     */
    private async createSessionObjects(device: EmbySession): Promise<void> {
        const sid = device.Id;
        await this.setObjectNotExistsAsync(sid, {
            type: 'device',
            common: { name: device.DeviceName || sid },
            native: {},
        });
        // the display name can be changed in the Emby dashboard (Devices), keep it in sync
        await this.extendObjectAsync(sid, {
            common: { name: device.DeviceName || sid },
            native: { deviceId: device.DeviceId || '' },
        });
        if (device.DeviceId) {
            await this.removeSupersededSessions(sid, device.DeviceId);
        }

        const objs: Record<string, ioBroker.SettableObject> = {
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
            await this.extendObjectAsync(`${sid}.${id}`, obj);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EmbyAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new EmbyAdapter())();
}
