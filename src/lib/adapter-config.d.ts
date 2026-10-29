// Augments the globally declared ioBroker types with everything this adapter adds.
// Keep in sync with `native` in io-package.json and with admin/jsonConfig.json.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Server address with port, e.g. 192.168.0.100:8096. The default 0.0.0.0:8096 means "not configured". */
            ip: string;
            /** Use https/wss instead of http/ws */
            isSSL: boolean;
            /** Emby API key (32 hex characters). In encryptedNative since 2.0.0; older versions stored it in plain text, see migratePlainApiKey(). */
            apikey: string;
            /** Comma separated session or device ids to ignore */
            deviceIds: string;
            /** Delay in ms before media.state leaves "playing" */
            timeout: number;
            /** REST poll of the sessions in seconds, 0 = off. Undefined for instances created by versions <= 1.3.0. */
            pollInterval: number;
            /** Remove objects of clients deleted in the Emby dashboard. Undefined (= true) for instances created by versions <= 1.3.0. */
            removeDeletedDevices: boolean;
            /** Remove objects of clients inactive for this many days, 0 = off */
            removeInactiveDays: number;
        }
    }
}

export {};
