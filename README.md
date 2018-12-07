![Logo](admin/emby.png)
# ioBroker.template
=================

This adapter is a template for the creation of an ioBroker adapter. You do not need it unless you plan on developing your own adapter.

It includes both code running within iobroker and as vis widget. If you only plan to create a vis widget then you should use the [iobroker.vis-template](https://github.com/ioBroker/ioBroker.vis-template) instead.

## Steps 
1. download and unpack this packet from github ```https://github.com/ioBroker/ioBroker.template/archive/master.zip```
  or clone git repository ```git clone --depth=1 https://github.com/ioBroker/ioBroker.template.git```

2. download required npm packets. Write in ioBroker.template directory:

  ```npm install```
  
3. set name of this template. Call
  
  ```gulp rename --name mynewname --email email@mail.com --author "Author Name"```
  
  *mynewname* must be **lower** case and with no spaces.

  If gulp is not available, install gulp globally:
  
  ```npm install -g gulp-cli```


## Objects

### Commands
* x.command.dialog   -
    Show a dialog on the selected Device.
    You can set Header and Body: Seperate it by '|'
    For example: Alarm|Some one opened the door.
    If no Header is given it will show ioBroker as Header.
* x.command.goHome   -
    Sends a command to the selected Device which will return to the Homescreen
* x.command.message  -
    Show a message on the selected Device for 5 sec.
* x.command.volume   -
    Sets the Volume of the selected Device.
    Doesn't work on the most of devices since it doenst controle the TV Volume.

 
 ## Changelog
 ### 0.0.2
* added more states
* added DisplayMessage

### 0.0.1
* Initial version