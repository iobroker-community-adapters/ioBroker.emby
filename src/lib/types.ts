// Payloads of the Emby server (WebSocket and REST). Only the fields the adapter reads are listed,
// all of them optional: the data comes from the server and is checked at runtime.

/** Item that is currently played by a session (`NowPlayingItem`) */
export interface EmbyNowPlayingItem {
    Id?: string;
    Name?: string;
    OriginalTitle?: string;
    Overview?: string;
    /** e.g. Movie, Episode, Audio */
    Type?: string;
    CommunityRating?: number;
    ProductionYear?: number;
    OfficialRating?: string;
    Taglines?: string[];
    Genres?: string[];
    BackdropImageTags?: string[];
    PrimaryImageAspectRatio?: number;
    SeriesId?: string;
    SeriesName?: string;
    SeasonId?: string;
    SeasonName?: string;
    /** Duration in ticks (1 tick = 100 ns) */
    RunTimeTicks?: number;
}

/** Playback state of a session (`PlayState`) */
export interface EmbyPlayState {
    /** Position in ticks (1 tick = 100 ns) */
    PositionTicks?: number;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    MediaSourceId?: string;
}

/** One entry of the `Sessions` list */
export interface EmbySession {
    /** Session id, changes on every reconnect of the client */
    Id: string;
    /** Stable id of the client */
    DeviceId?: string;
    DeviceName?: string;
    UserName?: string;
    SupportsRemoteControl?: boolean;
    SupportedCommands?: string[];
    /** ISO date */
    LastActivityDate?: string;
    NowPlayingItem?: EmbyNowPlayingItem;
    PlayState?: EmbyPlayState;
}

/** One entry of `GET /Devices` */
export interface EmbyDevice {
    /** Emby: DeviceId of the session */
    ReportedDeviceId?: string | null;
    /** Emby: internal number, Jellyfin: DeviceId */
    Id?: string | number | null;
}

/** Answer of `GET /Devices`: Emby sends `{ Items: [...] }`, some versions a plain array */
export type EmbyDevicesResponse = EmbyDevice[] | { Items?: EmbyDevice[] } | null;

/** Message received over the WebSocket */
export interface EmbySocketMessage {
    MessageType?: string;
    Data?: unknown;
}

/** Answer of `GET /System/Info` (only the fields the adapter reads) */
export interface EmbySystemInfo {
    ServerName?: string;
    Version?: string;
    HasUpdateAvailable?: boolean;
    HasPendingRestart?: boolean;
}

/** Message of `sendTo('emby.0', 'message', ...)` */
export interface SendMessagePayload {
    text?: string;
    header?: string;
    /** Display duration in ms; without it the client shows a dialog that stays until it is closed */
    timeoutMs?: number;
    /** Device key, session id, device id or device name; all connected clients if empty */
    device?: string;
}
