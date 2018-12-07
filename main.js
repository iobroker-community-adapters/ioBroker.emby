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
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:24.0) Gecko/20100101 Firefox/24.0',
            'Content-Type' : 'application/json' 
        };

		switch (cmd)
		{
            case 'command.message':
                adapter.log.info("Body: " + '{"Header":"Test", "Text":"' + state.val + '", "TimeoutMs":"5000" }');
                request.post({
                        uri: "http://" + adapter.config.ip + "/Sessions/" + dId + "/Message?api_key=" + adapter.config.apikey,
                        form: '{"Header":"Test", "Text":"' + state.val + '", "TimeoutMs":"5000" }',
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


            case 'command.goHome':
                request.post("http://" + adapter.config.ip + "/Sessions/" + dId + "/Command/GoHome?api_key=" + adapter.config.apikey,
                    { },
                    function(error, resp, body) {
                        if(!error)
                        adapter.setState(id, state.val, true);
                        else
                        adapter.log.info("Fehler: " + JSON.stringify(resp));
                    }
                );

                //connection.send('{"MessageType":"Command", "Data": { "Name": "DisplayMessage", "Arguments": { "Header": "Message from ioBroker", "Text": "' + state.val + '", "TimeoutMs": 3000 } } }');
                
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

                //connection.send('{"MessageType":"Command", "Data": { "Name": "DisplayMessage", "Arguments": { "Header": "Message from ioBroker", "Text": "' + state.val + '", "TimeoutMs": 3000 } } }');
                
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
}

function webOpen()
{
    connection.send('{"MessageType":"SessionsStart", "Data": "10000,10000"}');
    adapter.log.info("Mit Server verbunden.");
}

function webError(error)
{
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
            createDevice(d.Id, d.DeviceName);
            adapter.setState(d.Id + ".info.deviceName", d.DeviceName, true);

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
            } else {
                adapter.setState(d.Id + ".media.title", "", true);
                adapter.setState(d.Id + ".media.description", "", true);
                adapter.setState(d.Id + ".media.type", "None", true);
            }

            if(typeof d.PlaylistItemId !== 'undefined')
            {
                var ispaused;
                if(typeof d.PlayState.MediaSourceId !== 'undefined')
                {
                    ispaused = d.PlayState.IsPaused;
                } else {
                    ispaused = true;
                }

                adapter.setState(d.Id + ".media.isPaused", ispaused, true);
                adapter.setState(d.Id + ".media.isMuted", d.PlayState.IsMuted, true);
            } else {
                adapter.setState(d.Id + ".media.isPaused", true, true);
            }
            
        } else {
            
        adapter.log.debug("Device skipped: " + d.DeviceName);
        }
    }
}

function createDevice(id, dName)
{
    var sid = adapter.namespace + '.' + id;
    adapter.setObjectNotExists(sid, {
        type: 'channel',
        common: {
            name: dName
        },
        native: { }
    });
    adapter.setObjectNotExists(sid + ".info", {
        type: 'channel',
        common: {
            name: "Info"
        },
        native: { }
    });adapter.setObjectNotExists(sid + ".media", {
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
}