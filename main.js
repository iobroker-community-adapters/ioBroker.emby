'use strict';

var request = require('request');
var W3CWebSocket = require('websocket').w3cwebsocket;
const utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
const adapter = new utils.Adapter('emby');

var websocket;
var checkOnline;
var connection;

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
        connection.send('{"MessageType":"SessionsStop", "Data": ""}');
        websocket.close();
        checkOnline = null;
        adapter.log.info('cleaned everything up...');
        callback();
    } catch (e) {
        callback();
    }
});

// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});



adapter.on('stateChange', function (id, state) {
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

            case 'command.goHome':
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
                        form: { Arguments:{ "Volume": state.val } },
                        headers: headers
                    },
                    function(error, resp, body) {
                        if(!error)
                        adapter.setState(id, state.val, true);
                        else
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );
                break;

            default:
                adapter.log.info("Not supported command: " + id);
                break;
        }
    }
});

//adapter.on('message', function (obj) {
//    if (typeof obj === 'object' && obj.message) {
//        if (obj.command === 'send') {
//            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
//        }
//    }
//});

adapter.on('ready', function () {
    main();
});

function main() {
    adapter.subscribeStates('*');
    adapter.log.info("starting websocket");
    adapter.log.info("try to connect to: " + adapter.config.ip);
    connection = new W3CWebSocket('ws://' + adapter.config.ip + '?api_key=' + adapter.config.apikey + '&deviceId=00001'); //8306e66875c54b4c816fed315c3cd2e6
    adapter.log.info("started websocket");

    connection.onopen = webOpen;
    connection.onerror = webError;
    connection.onmessage = webMessage;

    
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
}

function webOpen()
{
    connection.send('{"MessageType":"SessionsStart", "Data": "10000,10000"}');
    adapter.log.info("Mit Server verbunden.");
    adapter.setState("info.connection", true, true);
}

function webError(error)
{
    adapter.setState("info.connection", false, true);
    adapter.log.error("Websocket Error : " + error);
}

function webMessage(e)
{
    var data = JSON.parse(e.data);

    for(var i = 0; i < data.Data.length; i++)
    {
        var d = data.Data[i];

        if(adapter.config.deviceIds == "" || ( adapter.config.deviceIds != "" && adapter.config.deviceIds.indexOf(d.Id) !== -1))
        {
            createDevice(d);
            adapter.setState(d.Id + ".info.deviceName", d.DeviceName, true);
            adapter.setState(d.Id + ".info.userName", d.UserName, true);

            if(typeof d.NowPlayingItem !== 'undefined')
            {
                var npi = d.NowPlayingItem;
                adapter.setState(d.Id + ".media.title", npi.Name, true);
                adapter.setState(d.Id + ".media.description", npi.Overview, true);
                adapter.setState(d.Id + ".media.type", npi.Type, true);

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
                        adapter.setState(d.Id + ".media.state", "paused", true);
                    else
                        adapter.setState(d.Id + ".media.state", "playing", true);
                    } else {
                    ispaused = true;
                }
            } else {
                adapter.setState(d.Id + ".media.title", "", true);
                adapter.setState(d.Id + ".media.description", "", true);
                adapter.setState(d.Id + ".media.type", "None", true);
                adapter.setState(d.Id + ".media.state", "idle", true);
            }

            
            
        } else {
            
        adapter.log.debug("Device skipped: " + d.DeviceName);
        }
    }
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



    adapter.setObjectNotExists(sid + ".media.isPaused", {
        "type": "state",
          "common": {
            "name": "If Media is paused",
            "role": "media.state",
            "type": "boolean",
            "read": true,
            "write": false
          },
          "native": {}
    });
    adapter.setObjectNotExists(sid + ".media.state", {
        "type": "state",
          "common": {
            "name": "State of the CLient",
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

    if(!device.SupportsRemoteControl)
        return;




    adapter.setObjectNotExists(sid + ".command", {
        type: 'channel',
        common: {
            name: "Controll Client"
        },
        native: { }
    });

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
                        "name": "Volume",
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
                        "name": "GoToSearch",
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
        }
    }


    
    
    
}