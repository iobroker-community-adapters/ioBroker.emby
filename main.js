'use strict';

let request = require('request');
let W3CWebSocket = require('websocket').w3cwebsocket;
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

let adapter;
let connection;
let laststates = { };
let timeoutretry;
let timeoutplays = { };
let timeoutstates = { };
let timeoutstarted = { };


function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: "emby",
        stateChange: fStateChange,
        unload: fUnload,
        ready: function() { main(); },
    });

    adapter = new utils.Adapter(options);

    return adapter;
};

// is called when adapter shuts down - callback has to be called under any circumstances!
function fUnload (callback) {
    try {
        connection.send('{"MessageType":"SessionsStop", "Data": ""}');
        if(connection != undefined) connection.close();
        checkOnline = null;
        laststates = { };

        Object.keys(timeoutplays).forEach((timeout) => { clearTimeout(timeoutplays[timeout]); })
        Object.keys(timeoutstates).forEach((timeout) => { clearTimeout(timeoutstates[timeout]); })
        Object.keys(timeoutstarted).forEach((timeout) => { clearTimeout(timeoutstarted[timeout]); })
        
        timeoutplays = { };
        timeoutstates = { };
        timeoutstarted = { };
        adapter.log.info('cleaned everything up...');
        clearTimeout(timeoutretry);
        callback();
    } catch (e) {
        callback();
    }
}

/*
// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});
*/


function fStateChange (id, state) {
    if (id && state && !state.ack)
	{
		id = id.substring(adapter.namespace.length + 1);

        if(id.indexOf("info.") !== -1 || id.indexOf("playing.") !== -1)
        {
            adapter.setState(id, state.val, true);
            return;
        }


        var dId = id.substring(0, id.indexOf('.'));
        var cmd = id.substring(dId.length + 1);
        
        var headers = { 
            'Content-Type' : 'application/json' 
        };

		switch (cmd)
		{
            case 'command.toggleplay':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Playing/PlayPause?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;


            case 'command.play':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Playing/Unpause?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.pause':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Playing/Pause?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.mute':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/Mute?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.unmute':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/Unmute?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.togglemute':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/ToggleMute?api_key=" + adapter.config.apikey,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.message':
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Message?api_key=" + adapter.config.apikey,
                        body: '{"Header":"Test", "Text":"' + state.val + '", "TimeoutMs":"5000" }',
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                            adapter.setState(id, "", true);
                        else
                            adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;


            case 'command.dialog':
                var jsonbody = '';
                if(state.val.indexOf('|') !== -1) {
                    var paras = state.val.split('|');
                    jsonbody = '{"Header":"' + paras[0] + '", "Text":"' + paras[1] + '" }';
                } else {
                    jsonbody = '{"Header":"ioBroker", "Text":"' + state.val + '" }';
                }

                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Message?api_key=" + adapter.config.apikey,
                        body: jsonbody,
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                        adapter.setState(id, "", true);
                        else
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;


            case 'command.goHome':
                request.post("http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/GoHome?api_key=" + adapter.config.apikey,
                    { },
                    function(error, resp, body) {
                        if(error)
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.goToSearch':
                request.post("http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/GoToSearch?api_key=" + adapter.config.apikey,
                    { },
                    function(error, resp, body) {
                        if(error)
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.back':
                request.post("http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/Back?api_key=" + adapter.config.apikey,
                    { },
                    function(error, resp, body) {
                        if(error)
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            case 'command.volume':
                adapter.log.info("http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/SetVolume?api_key=" + adapter.config.apikey);
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/SetVolume?api_key=" + adapter.config.apikey,
                        form: JSON.parse('{ Arguments:{ Volume: ' + state.val + ' } }'),
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                        adapter.setState(id, state.val, true);
                        else
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                adapter.log.info(JSON.stringify(JSON.parse('{ Arguments:{ Volume: ' + state.val + ' } }')));
                break;

            default:
                adapter.log.info("Not supported command: " + cmd + " | " + id);
                break;
        }
    }
}

//adapter.on('message', function (obj) {
//    if (typeof obj === 'object' && obj.message) {
//        if (obj.command === 'send') {
//            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
//        }
//    }
//});


function main() {
    adapter.subscribeStates('*');
    
    adapter.setObjectNotExists(adapter.namespace + ".info", {
        type: 'channel',
        common: {
            name: "Info"
        },
        native: { }
    });
    adapter.setObjectNotExists(adapter.namespace + ".info.connection", {
        "type": "state",
        "common": {
            "name": "If connected to Emby Server",
            "role": "indicator.connected",
            "type": "boolean",
            "read": true,
            "write": false,
            "def": false
        },
        "native": {}
    });

    tryConnect();
}

function tryConnect()
{
    try {
        if(adapter.config.apikey == "")
        {
            adapter.log.warn("There is no ApiKey. You can recieve information but cant controle clients.");
        }
    
        adapter.log.debug("try to connect to: " + adapter.config.ip);
        var prefix = adapter.config.isSSL ? "wss://" : "ws://";
        connection = new W3CWebSocket(prefix + adapter.config.ip + '?api_key=' + adapter.config.apikey + '&deviceId=00001'); //8306e66875c54b4c816fed315c3cd2e6
        
        connection.onopen = webOpen;
        connection.onerror = webError;
        connection.onmessage = webMessage;
    } catch(e) {
        adapter.setState("info.connection", false, true);
        adapter.log.warn("Verbindung konnte nicht hergestellt werden. Nächster Versuch in 1 Minute: \"" + e.message + "\"");
        timeoutretry = setTimeout(tryConnect, 60000);
    }
}

function webOpen()
{
    if(connection == undefined || connection.readyState !== 1) {
        adapter.log.error("Verbindung konnte nicht hergestellt werden. (readyState) Nächster Versuch in 1 Minute.");
        if(connection) connection.close();
        connection = null;
        timeoutretry = setTimeout(tryConnect, 60000);
        return;
    }
    connection.send('{"MessageType":"SessionsStart", "Data": "10000,10000"}');
    adapter.log.info("connected with emby (" + adapter.config.ip + ")");
    adapter.setState("info.connection", true, true);
}

function webError(error)
{
    adapter.setState("info.connection", false, true);
    adapter.log.debug("Websocket Error : " + JSON.stringify(error));
    adapter.log.error("WebSocket Error. Try Reconnect in 60s");

    timeoutretry = setTimeout(tryConnect, 60000);
}

function webMessage(e)
{
    var data = JSON.parse(e.data);

    adapter.log.debug(JSON.stringify(data));

    for(var i = 0; i < data.Data.length; i++)
    {
        var d = data.Data[i];

        if(adapter.config.deviceIds == "" || ( adapter.config.deviceIds != "" && adapter.config.deviceIds.indexOf(d.Id) == -1))
        {
            createDevice(d);
            if(typeof d.DeviceName !== 'undefined') adapter.setState(d.Id + ".info.deviceName", d.DeviceName, true);
            else adapter.setState(d.Id + ".info.deviceName", "", true);
            
            if(typeof d.UserName !== 'undefined') adapter.setState(d.Id + ".info.userName", d.UserName, true);
            else adapter.setState(d.Id + ".info.userName", "", true);
            
            if(typeof d.NowPlayingItem !== 'undefined')
            {
                var endString = "";
                if(d.NowPlayingItem.RunTimeTicks != null && d.PlayState.PositionTicks != null) {
                    var endDate = new Date(Date.now() + ((d.NowPlayingItem.RunTimeTicks - d.PlayState.PositionTicks) / 10000));
                    endString = endDate.getHours() + ":" + (endDate.getMinutes() < 10 ? "0"+endDate.getMinutes() : endDate.getMinutes()) ;
                }
			
                var npi = d.NowPlayingItem;
                adapter.setState(d.Id + ".media.endtime", endString, true);
                if(typeof npi.Name !== 'undefined') adapter.setState(d.Id + ".media.title", npi.Name, true);
                else adapter.setState(d.Id + ".media.title", "", true);

                if(typeof npi.Overview !== 'undefined') adapter.setState(d.Id + ".media.description", npi.Overview, true);
                else adapter.setState(d.Id + ".media.description", "", true);

                if(typeof npi.Type !== 'undefined') adapter.setState(d.Id + ".media.type", npi.Type, true);
                else adapter.setState(d.Id + ".media.type", "", true);
                
                if(typeof npi.CommunityRating !== 'undefined') adapter.setState(d.Id + ".media.rating", npi.CommunityRating, true);
                else adapter.setState(d.Id + ".media.rating", "", true);

                if(typeof npi.ProductionYear !== 'undefined') adapter.setState(d.Id + ".media.year", npi.ProductionYear, true);
                else adapter.setState(d.Id + ".media.year", "", true);

                if(typeof npi.Taglines !== 'undefined') adapter.setState(d.Id + ".media.tags", npi.Taglines.join(","), true);
                else adapter.setState(d.Id + ".media.tags", "", true);

                if(typeof npi.Genres !== 'undefined') adapter.setState(d.Id + ".media.genres", npi.Genres.join(","), true);
                else adapter.setState(d.Id + ".media.genres", "", true);

                if(typeof npi.BackdropImageTags !== 'undefined') adapter.setState(d.Id + ".media.backdropimage", npi.BackdropImageTags.join(","), true);
                else adapter.setState(d.Id + ".media.backdropimage", "", true);
                
                if(typeof npi.PrimaryImageAspectRatio != 'undefined') adapter.setState(d.Id + ".media.ratio", npi.PrimaryImageAspectRatio, true);
                else adapter.setState(d.Id + ".media.ratio", "", true);

                if(typeof npi.OfficialRating != 'undefined') adapter.setState(d.Id + ".media.agerating", npi.OfficialRating, true);
                else adapter.setState(d.Id + ".media.agerating", "", true);

                if(typeof npi.OriginalTitle != 'undefined') adapter.setState(d.Id + ".media.originaltitle", npi.OriginalTitle, true);
                else adapter.setState(d.Id + ".media.originaltitle", "", true);

                var prefix = adapter.config.isSSL ? "https://" : "http://";
                var basePoster = prefix + adapter.config.ip + "/Items/"

                switch(npi.Type) {
                    case "Episode":
                        adapter.setState(d.Id + ".posters.main", basePoster + npi.SeriesId + "/Images/Primary", true);
                        adapter.setState(d.Id + ".posters.season", basePoster + npi.SeasonId + "/Images/Primary", true);
                        adapter.setState(d.Id + ".posters.episode", basePoster + npi.Id + "/Images/Primary", true);
                        break;

                    case "Movie":
                        adapter.setState(d.Id + ".posters.main", basePoster + npi.Id + "/Images/Primary", true);
                        adapter.setState(d.Id + ".posters.season", "", true);
                        adapter.setState(d.Id + ".posters.episode", "", true);
                        break;

                    default:
                        adapter.setState(d.Id + ".posters.main", "", true);
                        adapter.setState(d.Id + ".posters.season", "", true);
                        adapter.setState(d.Id + ".posters.episode", "", true);
                        break;
                }

                if(typeof npi.SeasonName !== 'undefined')
                {
                    adapter.setState(d.Id + ".media.seasonName", npi.SeasonName, true);
                    adapter.setState(d.Id + ".media.seriesName", npi.SeriesName, true);
                } else {
                    adapter.setState(d.Id + ".media.seasonName", "", true);
                    adapter.setState(d.Id + ".media.seriesName", "", true);
                }

                var ispaused;
                if(typeof d.PlayState.MediaSourceId !== 'undefined')
                {
                    if(d.PlayState.IsPaused)
                        changeState(d.Id, "paused"); //adapter.setState(d.Id + ".media.state", "paused", true);
                    else
                        changeState(d.Id, "playing"); //adapter.setState(d.Id + ".media.state", "playing", true);
                } else {
                    changeState(d.Id, "paused"); //adapter.setState(d.Id + ".media.state", "paused", true);
                }
                adapter.setState(d.Id + ".media.isMuted", d.PlayState.IsMuted, true);
            } else {
                adapter.setState(d.Id + ".media.title", "", true);
                adapter.setState(d.Id + ".media.description", "", true);
                adapter.setState(d.Id + ".media.seasonName", "", true);
                adapter.setState(d.Id + ".media.seriesName", "", true);
                adapter.setState(d.Id + ".media.type", "None", true);
                adapter.setState(d.Id + ".media.endtime", "", true);
                adapter.setState(d.Id + ".posters.main", "", true);
                adapter.setState(d.Id + ".posters.season", "", true);
                adapter.setState(d.Id + ".posters.episode", "", true);
                changeState(d.Id, "idle"); //adapter.setState(d.Id + ".media.state", "idle", true);
            }
        } else {
            adapter.log.debug("Device skipped: " + d.DeviceName);
        }
    }
}

function changeState(id, state)
{
    if(laststates[id] == state)
        return;

    if(state == "playing")
    {
        clearTimeout(timeoutplays[id]);
        timeoutstarted[id] = false;
        adapter.setState(id + ".media.state", state, true);
    } else {
        timeoutstates[id] = state;
        if(!timeoutstarted[id])
        {
            timeoutstarted[id] = true;
            timeoutplays[id] = setTimeout(function() {
                adapter.setState(id + ".media.state", timeoutstates[id], true);
                timeoutstarted[id] = false;
            }, adapter.config.timeout);
        }
    }

    laststates[id] = state;
}

function createDevice(device)
{
    var sid = adapter.namespace + '.' + device.Id;
    adapter.setObjectNotExists(sid, {
        type: 'device',
        common: {
            name: device.DeviceName
        },
        native: { }
    });
    adapter.setObjectNotExists(sid + ".info", {
        type: 'channel',
        common: {
            name: "Info"
        },
        native: { }
    });
    adapter.setObjectNotExists(sid + ".media", {
        type: 'channel',
        common: {
            name: "Media Info"
        },
        native: { }
    });
    adapter.setObjectNotExists(sid + ".posters", {
        type: 'channel',
        common: {
            name: "Media Posters"
        },
        native: { }
    });



    adapter.setObjectNotExists(sid + ".info.deviceName", {
        "type": "state",
        "common": {
          "name": "Name of the Device now playing",
          "role": "info.name",
          "type": "string",
          "read": true,
          "write": false
        },
        "native": {}
    });
    adapter.setObjectNotExists(sid + ".info.userName", {
        "type": "state",
        "common": {
          "name": "Logged in User",
          "role": "info.name",
          "type": "string",
          "read": true,
          "write": false
        },
        "native": {}
    });
    adapter.setObjectNotExists(sid + ".info.supportedCommands", {
        "type": "state",
        "common": {
          "name": "List of supported Commands",
          "role": "info.name",
          "type": "string",
          "read": true,
          "write": false
        },
        "native": {}
    });


    adapter.setObjectNotExists(sid + ".media.state", {
        "type": "state",
          "common": {
            "name": "State of the Client",
            "role": "media.state",
            "type": "string",
            "read": true,
            "write": true,
            "states": {
                "idle": "Idle",
                "paused": "Paused",
                "playing": "Playing"
            }
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.isMuted", {
        "type": "state",
        "common": {
          "name": "If Player is muted",
          "role": "media.mute",
          "type": "boolean",
          "read": true,
          "write": false
        },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.title", {
        "type": "state",
          "common": {
            "name": "Title of file playing",
            "role": "media.title",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.seriesName", {
        "type": "state",
          "common": {
            "name": "Name of serie now playing",
            "role": "media.title",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.seasonName", {
        "type": "state",
          "common": {
            "name": "Name of season now playing",
            "role": "media.season",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.type", {
        "type": "state",
          "common": {
            "name": "Type of file playing",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.description", {
        "type": "state",
          "common": {
            "name": "Description of file playing",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.endtime", {
        "type": "state",
          "common": {
            "name": "Endtime of playing video/audio",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.rating", {
        "type": "state",
          "common": {
            "name": "Community Rating",
            "role": "state",
            "type": "number",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.year", {
        "type": "state",
          "common": {
            "name": "Production Year",
            "role": "state",
            "type": "number",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.tags", {
        "type": "state",
          "common": {
            "name": "Tags",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.genres", {
        "type": "state",
          "common": {
            "name": "Genres",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.backdropimage", {
        "type": "state",
          "common": {
            "name": "BackdropImageTags",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.ratio", {
        "type": "state",
          "common": {
            "name": "Ratio",
            "role": "state",
            "type": "number",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.agerating", {
        "type": "state",
          "common": {
            "name": "Age Rating",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.originaltitle", {
        "type": "state",
          "common": {
            "name": "Original Title",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });





    adapter.setObjectNotExists(sid + ".posters.main", {
        "type": "state",
          "common": {
            "name": "Main Poster",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".posters.episode", {
        "type": "state",
          "common": {
            "name": "Episode Poster",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".posters.season", {
        "type": "state",
          "common": {
            "name": "Season Poster",
            "role": "state",
            "type": "string",
            "read": true,
            "write": false
          },
          "native": {}
    });

    if(!device.SupportsRemoteControl)
        return;




    adapter.setObjectNotExists(sid + ".command", {
        type: 'channel',
        common: {
            name: "Controll Client"
        },
        native: { }
    });


    adapter.setObjectNotExists(sid + ".command.pause", {
        "type": "state",
        "common": {
            "name": "Pause",
            "role": "button",
            "type": "button",
            "read": false,
            "write": true
        },
        "native": {}
    });
    
    adapter.setObjectNotExists(sid + ".command.play", {
        "type": "state",
        "common": {
            "name": "Play",
            "role": "button",
            "type": "button",
            "read": false,
            "write": true
        },
        "native": {}
    });
    adapter.setObjectNotExists(sid + ".command.toggleplay", {
        "type": "state",
        "common": {
            "name": "Toggle Play",
            "role": "button",
            "type": "button",
            "read": false,
            "write": true
        },
        "native": {}
    });

    adapter.setState(sid + ".info.supportedCommands", JSON.stringify(device.SupportedCommands), true);
    
    for(var i = 0; i < device.SupportedCommands.length; i++)
    {
        switch(device.SupportedCommands[i])
        {
            case "DisplayMessage":
                adapter.setObjectNotExists(sid + ".command.message", {
                    "type": "state",
                    "common": {
                        "name": "Message",
                        "role": "state",
                        "type": "string",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                adapter.setObjectNotExists(sid + ".command.dialog", {
                    "type": "state",
                    "common": {
                        "name": "Message Dialog",
                        "role": "state",
                        "type": "string",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "GoHome":
                adapter.setObjectNotExists(sid + ".command.goHome", {
                    "type": "state",
                    "common": {
                        "name": "GoHome",
                        "role": "button",
                        "type": "boolean",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "SetVolume":
                adapter.setObjectNotExists(sid + ".command.volume", {
                    "type": "state",
                    "common": {
                        "name": "Set Volume (causes crash on some devices)",
                        "role": "level.volume",
                        "type": "number",
                        "read": true,
                        "write": true
                    },
                    "native": {}
                });
                break;
                
            case "GoToSearch":
                adapter.setObjectNotExists(sid + ".command.goToSearch", {
                    "type": "state",
                    "common": {
                        "name": "Go to search",
                        "role": "button",
                        "type": "boolean",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "Back":
                adapter.setObjectNotExists(sid + ".command.back", {
                    "type": "state",
                    "common": {
                        "name": "Back",
                        "role": "button",
                        "type": "boolean",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "Mute":
                adapter.setObjectNotExists(sid + ".command.mute", {
                    "type": "state",
                    "common": {
                        "name": "Mute",
                        "role": "button",
                        "type": "button",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "UnMute":
                adapter.setObjectNotExists(sid + ".command.unmute", {
                    "type": "state",
                    "common": {
                        "name": "Unmute",
                        "role": "button",
                        "type": "button",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;

            case "ToggleMute":
                adapter.setObjectNotExists(sid + ".command.togglemute", {
                    "type": "state",
                    "common": {
                        "name": "Toggle Mute",
                        "role": "button",
                        "type": "button",
                        "read": false,
                        "write": true
                    },
                    "native": {}
                });
                break;
        }
    }


    
    
    
}


if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
} 
