'use strict';

// Integration test against a mock Emby server (HTTP + WebSocket on 127.0.0.1).
// Covers: API key migration, keepalive, invalid messages, commands, reconnect, offline marking,
// device ids as object ids, migration of objects of version 2.x / 1.3.0, cleanup.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { tests } = require('@iobroker/testing');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.EMBY_MOCK_PORT) || 18096;
const KEY = '0123456789abcdef0123456789abcdef';
const WEB_DEVICE_ID = 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2fDE3NTk5NDkyMzg2NDU1';
const WEB_KEY = crypto.createHash('sha1').update(WEB_DEVICE_ID).digest('hex').substring(0, 16);

const requests = [];
const wsReceived = [];
let connections = 0;
let currentSocket = null;
let currentSessions = [];

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        requests.push({
            method: req.method,
            url: req.url,
            token: req.headers['x-emby-token'],
            auth: req.headers['x-emby-authorization'],
            body,
        });
        if (req.method === 'GET' && req.url === '/Devices') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // dev-pc was removed in the dashboard
            res.end(
                JSON.stringify({
                    Items: ['dev-tv', 'dev-old', 'dev-recent', WEB_DEVICE_ID].map((id, i) => ({
                        Id: String(i + 1),
                        ReportedDeviceId: id,
                    })),
                }),
            );
            return;
        }
        if (req.method === 'GET' && req.url === '/Sessions') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(currentSessions));
            return;
        }
        res.writeHead(204);
        res.end();
    });
});
const wss = new WebSocketServer({ server });

function tvSession(playing, remote = true, id = 'tv1') {
    return {
        Id: id,
        DeviceId: 'dev-tv',
        DeviceName: 'Test TV',
        LastActivityDate: '2026-10-27T15:00:00.0000000Z',
        UserName: 'tester',
        SupportsRemoteControl: remote,
        SupportedCommands: ['DisplayMessage', 'SetVolume', 'Mute', 'Unmute', 'ToggleMute', 'GoHome', 'Back'],
        PlayState: playing
            ? { MediaSourceId: 'x', IsPaused: false, IsMuted: false, VolumeLevel: 30, PositionTicks: 0 }
            : {},
        NowPlayingItem: playing
            ? {
                  Id: 'm1',
                  Name: 'Film "mit" Quotes',
                  Type: 'Movie',
                  RunTimeTicks: 36000000000,
                  CommunityRating: 7.5,
                  ProductionYear: 2020,
                  Genres: ['Drama'],
              }
            : undefined,
    };
}

function webSession(id, playing) {
    return {
        Id: id,
        DeviceId: WEB_DEVICE_ID,
        DeviceName: 'Edge Windows',
        SupportsRemoteControl: true,
        SupportedCommands: ['DisplayMessage'],
        LastActivityDate: new Date().toISOString(),
        PlayState: playing ? { MediaSourceId: 'y' } : {},
        NowPlayingItem: playing ? { Id: 'm2', Name: 'Web movie', Type: 'Movie' } : undefined,
    };
}

wss.on('connection', (socket, req) => {
    connections++;
    currentSocket = socket;
    socket.reqUrl = req.url;
    socket.on('message', m => wsReceived.push(JSON.parse(m.toString())));
    socket.send(JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 6 }));
    socket.send('not json at all');
    // used to create "undefined" devices in 1.3.0
    socket.send(JSON.stringify({ MessageType: 'UserDataChanged', Data: 'abc' }));
    const self = { Id: 'self1', DeviceId: 'ioBroker-emby.0', DeviceName: 'Emby', Client: 'ioBroker' };
    if (connections === 1) {
        const pc = { Id: 'pc1', DeviceId: 'dev-pc', DeviceName: 'Test PC', SupportsRemoteControl: false };
        const old = {
            Id: 'old1',
            DeviceId: 'dev-old',
            DeviceName: 'Old Phone',
            SupportsRemoteControl: false,
            LastActivityDate: '2020-01-01T00:00:00.0000000Z',
        };
        const recent = {
            Id: 'recent1',
            DeviceId: 'dev-recent',
            DeviceName: 'Recent Phone',
            SupportsRemoteControl: false,
            LastActivityDate: new Date().toISOString(),
        };
        // two browser tabs of the same client, only the second one plays
        const tabs = [webSession('web-a', false), webSession('web-b', true)];
        // web clients first report SupportsRemoteControl=false, then true
        currentSessions = [tvSession(true, false), self, pc, old, recent, ...tabs];
        socket.send(JSON.stringify({ MessageType: 'Sessions', Data: currentSessions }));
        setTimeout(() => {
            currentSessions = [tvSession(true, true), self, pc, old, recent, ...tabs];
            socket.send(JSON.stringify({ MessageType: 'Sessions', Data: currentSessions }));
        }, 1000);
    } else {
        // the TV reconnected with a new session id, the PC is gone; like Emby, no push after connect,
        // the adapter has to read the sessions via REST
        currentSessions = [tvSession(false, true, 'tv2')];
    }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Creates objects like an older version did.
 *
 * @param harness test harness
 * @param sid session id used as object id
 * @param deviceId stored device id (2.x) or undefined (1.3.0)
 */
async function seedLegacyDevice(harness, sid, deviceId) {
    const base = `emby.0.${sid}`;
    await harness.objects.setObjectAsync(base, {
        type: 'device',
        common: { name: 'legacy' },
        native: deviceId ? { deviceId } : {},
    });
    await harness.objects.setObjectAsync(`${base}.media`, { type: 'channel', common: { name: 'Media' }, native: {} });
    await harness.objects.setObjectAsync(`${base}.media.title`, {
        type: 'state',
        common: {
            name: 'Title',
            type: 'string',
            role: 'media.title',
            read: true,
            write: false,
            custom: { 'history.0': { enabled: true } },
        },
        native: {},
    });
    await harness.states.setStateAsync(`${base}.media.title`, { val: `old title ${sid}`, ack: true });
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('against a mock Emby server', getHarness => {
            let harness;
            const st = async id => (await harness.states.getStateAsync(`emby.0.${id}`))?.val;
            const obj = id => harness.objects.getObjectAsync(`emby.0.${id}`);

            before(async function () {
                this.timeout(60_000);
                await new Promise(r => server.listen(PORT, '127.0.0.1', r));
                harness = getHarness();
                await harness.changeAdapterConfig('emby', {
                    native: {
                        ip: `127.0.0.1:${PORT}`,
                        apikey: 'placeholder',
                        isSSL: false,
                        deviceIds: '',
                        timeout: 500,
                        pollInterval: 5,
                        removeDeletedDevices: true,
                        removeInactiveDays: 30,
                    },
                });
                // simulate a key stored in plain text by version 1.3.0
                const inst = await harness.objects.getObjectAsync('system.adapter.emby.0');
                inst.native.apikey = KEY;
                await harness.objects.setObjectAsync('system.adapter.emby.0', inst);
                // objects of version 2.x (device id known) and 1.3.0 (no device id)
                await seedLegacyDevice(harness, 'sess-legacy', 'dev-tv');
                await seedLegacyDevice(harness, 'pc1', undefined);
                await harness.objects.setObjectAsync('enum.rooms.living', {
                    type: 'enum',
                    common: { name: 'Living room', members: ['emby.0.sess-legacy.media.title'] },
                    native: {},
                });
                await harness.startAdapterAndWait();
                await sleep(8000);
            });

            after(() => {
                wss.close();
                server.close();
            });

            it('stores the api key encrypted', async () => {
                const inst = await harness.objects.getObjectAsync('system.adapter.emby.0');
                assert.match(inst.native.apikey, /^\$\/aes-192-cbc:/);
            });

            it('connects with key and per-instance device id and subscribes', () => {
                assert.ok(currentSocket.reqUrl.includes(`api_key=${KEY}`));
                assert.ok(currentSocket.reqUrl.includes('deviceId=ioBroker-emby.0'));
                assert.ok(wsReceived.some(m => m.MessageType === 'SessionsStart'));
                assert.ok(wsReceived.some(m => m.MessageType === 'KeepAlive'));
            });

            it('migrates objects of version 2.x to the device id', async () => {
                assert.equal(await obj('sess-legacy'), null);
                const title = await obj('dev-tv.media.title');
                assert.deepEqual(title.common.custom, { 'history.0': { enabled: true } });
                const room = await harness.objects.getObjectAsync('enum.rooms.living');
                assert.deepEqual(room.common.members, ['emby.0.dev-tv.media.title']);
            });

            it('migrates objects of version 1.3.0 when the session is reported', async () => {
                assert.equal(await obj('pc1.media.title'), null);
                assert.equal((await obj('dev-pc')).native.deviceId, 'dev-pc');
            });

            it('creates one device per client with correct states', async () => {
                assert.equal(await st('info.connection'), true);
                assert.equal(await st('dev-tv.info.online'), true);
                assert.equal(await st('dev-tv.info.sessionId'), 'tv1');
                assert.equal(await st('dev-tv.info.deviceId'), 'dev-tv');
                assert.equal(await st('dev-tv.media.state'), 'playing');
                assert.equal(await st('dev-tv.media.title'), 'Film "mit" Quotes');
                assert.equal(await st('dev-tv.media.rating'), 7.5);
                assert.equal(await st('dev-tv.command.volume'), 30);
                assert.equal(await st('dev-tv.info.lastActivity'), Date.parse('2026-10-27T15:00:00Z'));
                assert.equal((await obj('dev-tv.command.unmute')).common.type, 'boolean');
                // long web client ids are hashed, two tabs give one device, the playing tab wins
                assert.equal(await st(`${WEB_KEY}.info.sessionId`), 'web-b');
                assert.equal(await st(`${WEB_KEY}.media.title`), 'Web movie');
                // own connection and invalid messages create nothing
                assert.equal(await obj('self1'), null);
                assert.equal(await obj('ioBroker-emby_0'), null);
                assert.equal(await obj('undefined'), null);
                const getSessions = requests.find(r => r.method === 'GET' && r.url === '/Sessions');
                assert.ok(getSessions.auth.includes('DeviceId="ioBroker-emby.0"'));
            });

            it('sends commands to the current session of the client', async function () {
                this.timeout(30_000);
                await harness.states.setStateAsync('emby.0.dev-tv.command.volume', { val: 55, ack: false });
                await harness.states.setStateAsync('emby.0.dev-tv.command.dialog', {
                    val: 'Klingel|Es hat "geklingelt"',
                    ack: false,
                });
                await harness.states.setStateAsync('emby.0.dev-tv.command.pause', { val: true, ack: false });
                await harness.states.setStateAsync(`emby.0.${WEB_KEY}.command.message`, { val: 'hi', ack: false });
                await sleep(2000);
                const vol = requests.find(r => r.url === '/Sessions/tv1/Command');
                assert.equal(vol.token, KEY);
                assert.deepEqual(JSON.parse(vol.body), { Name: 'SetVolume', Arguments: { Volume: '55' } });
                const dlg = requests.find(r => r.url === '/Sessions/tv1/Message');
                assert.deepEqual(JSON.parse(dlg.body), { Header: 'Klingel', Text: 'Es hat "geklingelt"' });
                assert.ok(requests.some(r => r.url === '/Sessions/tv1/Playing/Pause'));
                assert.ok(requests.some(r => r.url === '/Sessions/web-b/Message'));
                assert.ok(requests.every(r => !r.url.includes('api_key')));
            });

            it('reconnects, keeps the device id across session changes and cleans up', async function () {
                this.timeout(120_000);
                currentSocket.close();
                await sleep(1000);
                assert.equal(await st('info.connection'), false);
                await sleep(63_000);
                assert.equal(connections, 2);
                assert.equal(await st('info.connection'), true);
                // same object, new session id
                assert.equal(await st('dev-tv.info.sessionId'), 'tv2');
                assert.equal(await st('dev-tv.info.online'), true);
                assert.equal(await st('dev-tv.media.state'), 'idle');
                // dev-pc: removed in Emby, dev-old: inactive since 2020 -> both removed by the poll
                await sleep(7000);
                assert.equal(await obj('dev-pc'), null);
                assert.equal(await obj('dev-old'), null);
                assert.equal(await st('dev-recent.info.online'), false);
                assert.notEqual(await obj('dev-recent'), null);
                // commands follow the new session id
                await harness.states.setStateAsync('emby.0.dev-tv.command.pause', { val: true, ack: false });
                await sleep(1000);
                assert.ok(requests.some(r => r.url === '/Sessions/tv2/Playing/Pause'));
            });

            it('recreates objects deleted by the user and does not resurrect inactive ones', async function () {
                this.timeout(30_000);
                for (const id of ['emby.0.dev-tv', 'emby.0.dev-recent']) {
                    const rows = (await harness.objects.getObjectListAsync({ startkey: id, endkey: `${id}.香` })).rows;
                    for (const row of rows) {
                        await harness.objects.delObjectAsync(row.id);
                        await harness.states.delState(row.id);
                    }
                }
                await sleep(500);
                currentSocket.send(JSON.stringify({ MessageType: 'Sessions', Data: [tvSession(false, true, 'tv2')] }));
                await sleep(1500);
                assert.equal((await obj('dev-tv')).common.name, 'Test TV');
                assert.notEqual(await obj('dev-tv.media.title'), null);
                assert.equal(await obj('dev-recent'), null);
                assert.equal(await harness.states.getStateAsync('emby.0.dev-recent.media.title'), null);
            });
        });
    },
});
