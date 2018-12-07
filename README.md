![Logo](admin/emby.png)
# ioBroker.template
=================

This adapter is a template for the creation of an ioBroker adapter. You do not need it unless you plan on developing your own adapter.

It includes both code running within iobroker and as vis widget. If you only plan to create a vis widget then you should use the [iobroker.vis-template](https://github.com/ioBroker/ioBroker.vis-template) instead.

## Steps 
1. Install the Adapter from Github

2. Edit the Settings and enter the IP, ApiKey and maybe some DeviceIds you want to ignore.

  ```IP **with** Port => 192.168.0.100:8096```
  
3. Save and restart the Adapter.

4. To see the first Items you will have to open a Emby Client to recieve some Data.
  
  ```The Adapter will not get Data if **no** client is open.```


## Objects

### Infos
* x.info.deviceName
  - Shows the Name of the Device


### Media
* x.media.description
  - Description of the shown File.
* x.media.isMuted
  - If Media is Muted. Not all devices support this and will be False.
* x.media.isPaused
  - If Media is Paused. Will also be True if User closes the client.
* x.media.title
  - The Title of the shown File.
* x.media.type
  - The Type of the shown File. (Episode, Video, Book, etc)
* x.media.seasonName
  - The Name of the Season if .media.type is Episode otherwise it will be empty.
* x.media.seriesName
  - The Name of the Serie if .media.type is Episode otherwise it will be empty.


| Command | Description | Info |
| ------------- | ------------- |
| x.media.description  | Description of the shown File.  |  |
| Content Cell  | Content Cell  |


### Commands
* x.command.dialog
  - Show a dialog on the selected Device.
    You can set Header and Body: Seperate it by '|'
    For example: Alarm|Some one opened the door.
    If no Header is given it will show ioBroker as Header.
* x.command.goHome
  - Sends a command to the selected Device which will return to the Homescreen
* x.command.message
  - Show a message on the selected Device for 5 sec.
* x.command.volume
  - Sets the Volume of the selected Device.
    Doesn't work on the most of devices since it doenst controle the TV Volume.

 
 ## Changelog
 ### 0.0.2
* added more states
* added DisplayMessage

### 0.0.1
* Initial version