var util = require('util');
var EventEmitter = require('events').EventEmitter;
var exec = require('child_process').exec;
var _ = require('underscore');

var Wireless = function(config) {
    EventEmitter.call(this);

    // List of networks (key is address)
    this.networks = {};

    // ID for scanner interval
    this.scanTimer = null;

    // ID for connection checking interval
    this.connectTimer = null;

    // True if we're shutting down
    this.killing = false;

    // True if we're connected to a network
    this.connected = false;

    // Interface to listen on. TODO: handle multiple
    this.iface = config.iface || 'wlan0';
    this.iface2 = config.iface2 || false;

    // How often to poll the listing of networks
    this.updateFrequency = config.updateFrequency || 60;

    // How often should we check if we're connected to a network? (this is a pretty fast operation)
    this.connectionSpyFrequency = config.connectionSpyFrequency || 5;

    // How many scans should an AP not be in the results before we consider it vanished
    this.vanishThreshold = config.vanishThreshold || 2;

    this.commands = _.extend({}, this.COMMANDS, config.commands);

    // Translates each individual command
    for (var command in this.commands) {
        this.commands[command] = this._translate(this.commands[command], {
            'interface2': this.iface2,
            'interface': this.iface,
        });
    }
};

util.inherits(Wireless, EventEmitter);

Wireless.prototype.COMMANDS = {
    scan: 'sudo iw dev :INTERFACE scan',
    scan2: 'sudo iw dev :INTERFACE2 scan',
    stat: 'sudo iw dev :INTERFACE link',
    disable: 'sudo ifconfig :INTERFACE down',
    enable: 'sudo ifconfig :INTERFACE up',
    interfaces: 'sudo iw dev',
    dhcp: 'sudo dhclient :INTERFACE',
    dhcp_disable: 'dhclient -r :INTERFACE; sudo killall dhclient',
    leave: 'sudo killall wpa_supplicant',

    metric: 'sudo ifconfig :INTERFACE metric :METRIC',
    connect_wep: 'sudo iw :INTERFACE connect ":ESSID" keys :PASSWORD',
    connect_wpa: 'sudo wpa_passphrase ":ESSID" ":PASSWORD" > /tmp/wpa-temp.conf && sudo wpa_supplicant -B -D nl80211 -i :INTERFACE -c /tmp/wpa-temp.conf && rm /tmp/wpa-temp.conf',
    connect_open: 'sudo iw :INTERFACE connect ":ESSID"',
};

// Translates strings. Looks for :SOMETHING in string, and replaces is with data.something.
Wireless.prototype._translate = function(string, data) {
    for (var index in data) {
        if (!data.hasOwnProperty(index) || !data[index]) continue;
        var safe = data[index].match(/^[a-z0-9~!@#$%^&*()\-+=_\[\]{}\\|\/,.<>?'’: ]+$/i);
        if(safe) {   
            string = string.replace(':' + index.toUpperCase(), data[index]);
        }
    }

    return string;
};

// Start listening, runs in a loop
Wireless.prototype.start = function() {
    var self = this;

    // Check for networks
    this._executeScan();
    this.scanTimer = setInterval(function() {
        //if(!self.connected) {
            self._executeScan();
        //}
    }, this.updateFrequency * 1000);

    // Are we connected?
    this._executeTrackConnection();
    this.connectTimer = setInterval(function() {
        self._executeTrackConnection();
    }, this.connectionSpyFrequency * 1000);
};

// Every time we find a network during a scan, we pass it through this function
Wireless.prototype._seeNetwork = function(network) {
    if (this.networks[network.address]) {
        var oldNetwork = this.networks[network.address];

        if (oldNetwork.ssid != network.ssid || oldNetwork.encryption_any != network.encryption_any) {
            this.emit('change', network);
        } else if (oldNetwork.strength != network.strength || oldNetwork.quality != network.quality) {
            this.emit('signal', network);
        }

        this.networks[network.address] = network;
    } else {
        this.networks[network.address] = network;

        this.emit('appear', network);
    }
};

// Stop listening
Wireless.prototype.stop = function(callback) {
    this.killing = true;
    clearInterval(this.scanTimer);
    clearInterval(this.connectTimer);

    this.emit('stop');

    callback && callback();
};

// Returns a listing of networks from the last scan
// Doesn't need a callback, just getting the last list, not doing a new scan
Wireless.prototype.list = function() {
    return this.networks;
};

// Attempts to run dhcpcd on the interface to get us an IP address
Wireless.prototype.dhcp = function(callback) {
    var self = this;

    this.emit('command', this.commands.dhcp);

    exec(this.commands.dhcp, function(err, stdout, stderr) {
        if (err) {
            self.emit('error', "There was an unknown error enabling dhcp" + err);
            callback && callback(err);
            return;
        }

        // Command output is over stderr :'(
        var lines = stderr.split(/\r\n|\r|\n/);
        var ip_address = null;
        var temp = null;

        _.each(lines, function(line) {
            temp = line.match(/leased (\b(?:\d{1,3}\.){3}\d{1,3}\b) for [0-9]+ seconds/);
            if (temp) {
                ip_address = temp[1];
            }
        });

        if (ip_address) {
            self.emit('dhcp', ip_address);
            callback && callback(null, ip_address);
            return;
        }

        self.emit('error', "Couldn't get an IP Address from DHCP");
        callback && callback(true);
    });
};

// Disables DHCPCD
Wireless.prototype.dhcpStop = function(callback) {
    var self = this;

    this.emit('command', this.commands.dhcp_disable);

    exec(this.commands.dhcp_disable, function(err, stdout, stderr) {
        if (err) {
            self.emit('error', "There was an unknown error disabling dhcp" + err);
            callback && callback(err);
            return;
        }

        callback && callback(null);
    });
};

// Enables the interface (ifconfig UP)
Wireless.prototype.enable = function(callback) {
    var self = this;

    this.emit('command', this.commands.enable);

    exec(this.commands.enable, function(err, stdout, stderr) {
        if (err) {
            if (err.message.indexOf("No such device")) {
                self.emit('error', "The interface " + self.iface + " does not exist.");
                callback && callback(err);
                return;
            }

            self.emit('error', "There was an unknown error enabling the interface" + err);
            callback && callback(err);
            return;
        }

        if (stdout || stderr) {
            self.emit('error', "There was an error enabling the interface" + stdout + stderr);
            callback && callback(stdout || stderr);
            return;
        }

        callback && callback(null);
    });
};

// Disables the interface (ifconfig DOWN)
Wireless.prototype.disable = function(callback) {
    var self = this;

    this.emit('command', this.commands.disable);

    exec(this.commands.disable, function(err, stdout, stderr) {
        if (err) {
            self.emit('error', "There was an unknown error disabling the interface" + err);
            callback && callback(err);
            return;
        }

        if (stdout || stderr) {
            self.emit('error', "There was an error disabling the interface" + stdout + stderr);
            callback && callback(stdout || stderr);
            return;
        }

        callback && callback(null);
    });
};

// Attempts to connect to the specified network
Wireless.prototype.join = function(network, password, callback) {
    var self = this;
    var cb = function() {
        self.connected = false;
        self._executeTrackConnection(function(){
            return callback && callback();
        });
    }
    if (network.encryption_wep) {
        this._executeConnectWEP(network.ssid, password, cb);
    } else if (network.encryption_wpa || network.encryption_wpa2) {
        this._executeConnectWPA(network.ssid, password, cb);
    } else {
        this._executeConnectOPEN(network.ssid, cb);
    }
};

// Attempts to disconnect from the specified network
Wireless.prototype.leave = function(callback) {
    var self = this;

    this.emit('command', this.commands.leave);
    exec(this.commands.leave, function(err, stdout, stderr) {
        self._executeTrackConnection(function(){
            if (err) {
                self.emit('error', "There was an error when we tried to disconnect from the network");
                callback && callback(err);
                return;
            }

            callback && callback(null);
        });
    });
};

// Parses the output from `iwlist IFACE scan` and returns a pretty formattted object
Wireless.prototype._parseScan = function(scanResults) {
    var lines = scanResults.split(/\r\n|\r|\n/);
    var networks = [];
    var network = {};
    var networkCount = 0;

    _.each(lines, function(line) {
        line = line.replace(/\s+$/g,"");

        // a "BSS" line means that we've found a start of a new network
        if (line.indexOf('BSS') === 0) {
            networkCount++;
            if (!_.isEmpty(network)) {
                networks.push(network);
            }

            network = {
                last_tick: 0,
                ssid: "unknown",
                encryption_any: false,
                encryption_wep: false,
                encryption_wpa: false,
                encryption_wpa2: false,
            };
            var matches = line.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/);
            if(matches.length > 0) network.address = matches[0];
        } else {
            line = line.replace(/^\s+/g,"");
            if (line.indexOf('DS Parameter set: channel ') === 0) {
                var matches = line.match(/DS Parameter set: channel ([0-9]{1,2})/);
                if(matches && matches.length > 1) {
                    network.channel = matches[1];
                }
            } else if (line.indexOf('signal:') === 0) {
                var matches = line.match(/signal: (\d+)[^\d]/);
                if (matches && matches.length >= 2) {
                    network.signal = parseInt(sMatch[1], 10);
                }
            } else if (line.indexOf('SSID') === 0) {
                var matches = line.match(/SSID: (.*)/);
                if(matches && matches.length > 1) {
                    network.ssid = matches[1];
                }
            } else if (line.indexOf('RSN:') === 0) {
                network.encryption_any = true;
                network.encryption_wep = false;
                network.encryption_wpa2 = true;
            } else if (line.indexOf('WPS:') === 0) {
                network.encryption_any = true;
                network.encryption_wep = false;
                network.encryption_wpa = true;
            }
        }
    });

    if (!_.isEmpty(network)) {
        networks.push(network);
    }

    // TODO: Deprecated, will be removed in 0.5.0 release
    if (networkCount === 0) {
        this.emit('empty');
    }

    return networks;
};

// Executes a scan, reporting each network we see
Wireless.prototype._executeScan = function(cmd) {
    var self = this;
    var scanCommand = cmd || this.commands.scan;
    // Make this a non annonymous function, run immediately, then run interval which runs function
    this.emit('command', scanCommand);

    exec(scanCommand, function(err, stdout, stderr) {
        if (err) {
            if (self.killing) {
                // Of course we got an error the main app is being killed, taking iwlist down with it
                return;
            }
            if(err == -16) {
                if(!cmd && this.iface2) return self._executeScan(self.commands.scan2);
            } else {
                self.emit('error', "Got some major errors from our scan command (" + scanCommand + "):" + err);
                // TODO: Destroy
            }
            return;
        }

        if (stderr) {
            if (stderr.match(/Device or resource busy/)) {
                self.emit('error', "Scans are overlapping; slow down update frequency");
                return;
            } else if (stderr.match(/Allocation failed/)) {
                self.emit('error', "Too many networks for iwlist to handle");
                return;
            } else {
                self.emit('error', "Got some errors from our scan command: ", stderr);
            }
        }

        if (!stdout) {
            return;
        } else if (stdout.match(/scan aborted/i)) {
            if(!cmd && this.iface2) return self._executeScan(self.commands.scan2);
            return;
        }

        var content = stdout.toString();
        var networks = self._parseScan(content);

        // emit the raw data TODO: Deprecated, removed in 0.5.0
        self.emit('batch', networks);

        _.each(networks, function(network) {
            self._seeNetwork(network);
        });

        self._decay();
    });
};

// Checks to see if we are connected to a wireless network and have an IP address
Wireless.prototype._executeTrackConnection = function(callback) {
    var self = this;

    this.emit('command', this.commands.stat);

    exec(this.commands.stat, function(err, stdout, stderr) {
        if (err) {
            self.emit('error', "Error getting wireless devices information (" + self.commands.stat + ")", err);
            // TODO: Destroy
            return callback && callback();
        }

        var content = stdout.toString();
        var lines = content.split(/\r\n|\r|\n/);
        var foundOutWereConnected = false;
        var networkJoined = {};

        if (lines[0].indexOf('Connected to ') !== -1) {
            foundOutWereConnected = true;
            _.each(lines, function(line) {
                if (line.indexOf('Connected to ') !== -1) {
                    var matches = line.match(/Connected to ([a-fA-F0-9:]*)/);
                    if(matches && matches.length > 1) {
                        networkJoined.address = matches[1] || null;
                    }
                } else if (line.indexOf('SSID') !== -1) {
                    var matches = line.match(/SSID: (.*)/);
                    if(matches && matches.length > 1) {
                        networkJoined.ssid = matches[1] || null;
                    }
                }
            });
        }

        // guess we're not connected after all
        if (!foundOutWereConnected && self.connected) {
            self.connected = false;
            self.emit('leave');
        } else if (foundOutWereConnected && !self.connected) {
            self.connected = true;
            var network = self.networks[networkJoined.address];

            if (network) {
                self.emit('join', network);
                return callback && callback();
            }

            self.emit('former', networkJoined);
        }
        return callback && callback();
    });
};

// Connects to a WEP encrypted network
Wireless.prototype._executeConnectWEP = function(essid, password, callback) {
    var self = this;

    var command = this._translate(this.commands.connect_wep, {
        essid: essid,
        password: password
    });

    this.emit('command', command);

    exec(command, function(err, stdout, stderr) {
        if (err || stderr) {
            self.emit('error', "Shit is broken TODO");
            console.log(err);
            console.log(stderr);

            callback && callback(err || stderr);
            return;
        }

        callback && callback(null);
    });
};

// Connects to a WPA or WPA2 encrypted network
Wireless.prototype._executeConnectWPA = function(essid, password, callback) {
    var self = this;

    var command = this._translate(this.commands.connect_wpa, {
        essid: essid,
        password: password
    });

    this.emit('command', command);

    exec(command, function(err, stdout, stderr) {
         if (err || stderr) {
            self.emit('error', "Shit is broken TODO");
            console.log(err);
            console.log(stderr);

            callback && callback(err || stderr);
            return;
        }

        callback && callback(null);
    });
};

// Connects to an unencrypted network
Wireless.prototype._executeConnectOPEN = function(essid, callback) {
    var self = this;

    var command = this._translate(this.commands.connect_open, {
        essid: essid
    });

    this.emit('command', command);

    exec(command, function(err, stdout, stderr) {
        if (err || stderr) {
            self.emit('error', "There was an error joining an open network");
            console.log(err);
            console.log(stderr);

            callback && callback(err || stdout);
            return;
        }

        callback && callback(null);
    });
};

// Go over each network, increment last_tick, if it equals the threshold, send an event
Wireless.prototype._decay = function() {
    // _.each can't iterate self.networks for some reason
    for (var address in this.networks) {
        if (!this.networks.hasOwnProperty(address)) {
            break;
        }

        var this_network = this.networks[address];
        this_network.last_tick++;

        if (this_network.last_tick == this.vanishThreshold+1) {
            this.emit('vanish', this_network);
        }
    }
};

module.exports = Wireless;
