'use strict';

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

        adapter.setState(id, state.val, true);
//		switch (id)
//		{
//			case 'media_state':
//                
//                break;
//        }
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
    connection = new W3CWebSocket('ws://' + adapter.config.ip + '?api_key=8306e66875c54b4c816fed315c3cd2e6&deviceId=00001');
    adapter.log.info("started websocket");

    connection.onopen = webOpen;
    connection.onerror = webError;
    connection.onmessage = webMessage;
}

function webOpen()
{
    connection.send('{"MessageType":"SessionsStart", "Data": "2000,2000"}');
    adapter.log.info("Mit Server verbunden.");
}

function webError(error)
{
    adapter.log.error("Websocket Error : " + error);
}

function webMessage(e)
{
    var data = JSON.parse(e.data);
    var flagpaused = false;

    for(var i = 0; i < data.Data.length; i++)
    {
        var d = data.Data[i];

        if(typeof d.PlaylistItemId !== 'undefined')
        {
            flagpaused = true;
            var ispaused;
            if(typeof d.PlayState.MediaSourceId !== 'undefined')
            {
                ispaused = d.PlayState.IsPaused;
            } else {
                ispaused = true;
            }

            adapter.setState("info.isPaused", ispaused, true);
            adapter.setState("info.isMuted", d.PlayState.IsMuted, true);
            adapter.setState("info.deviceName", d.DeviceName, true);
        }
        
        if(typeof d.NowPlayingItem !== 'undefined')
        {
            var npi = d.NowPlayingItem;
            adapter.setState("playing.name", npi.Name, true);
            adapter.setState("playing.description", npi.Overview, true);
            adapter.setState("playing.type", npi.Type, true);

            if(typeof npi.SeasonName !== 'undefined')
            {
                adapter.setState("playing.seasonName", npi.SeasonName, true);
                adapter.setState("playing.seriesName", npi.SeriesName, true);
            } else {
                adapter.setState("playing.seasonName", "", true);
                adapter.setState("playing.seriesName", "", true);
            }
        }
    }

    if(!flagpaused)
        adapter.setState("isPaused", true, true);
}