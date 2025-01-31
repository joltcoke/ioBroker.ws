/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const adapterName = require('./package.json').name.split('.').pop();
const utils       = require('@iobroker/adapter-core'); // Get common adapter utils
const SocketWS    = require('./lib/socketWS.js');
const LE          = utils.commonTools.letsEncrypt;
const ws          = require('@iobroker/ws-server');

let webServer     = null;
let store         = null;
let secret        = 'Zgfr56gFe87jJOM'; // Will be generated by first start

let adapter;
function startAdapter(options) {
    options = options || {};

    Object.assign(options, {name: adapterName});

    adapter = new utils.Adapter(options);

    adapter.on('objectChange', (id, obj) => {
        if (webServer && webServer.io) {
            webServer.io.publishAll('objectChange', id, obj);
        }
    });

    adapter.on('stateChange', (id, state) => {
        if (webServer && webServer.io) {
            webServer.io.publishAll('stateChange', id, state);
        }
    });

    adapter.on('fileChange', (id, fileName, size) => {
        if (webServer && webServer.io) {
            webServer.io.publishFileAll(id, fileName, size);
        }
    });

    adapter.on('unload', callback => {
        try {
            adapter.setState && adapter.setState('info.connected', '', true);
            adapter.setState && adapter.setState('info.connection', false, true);
            adapter.log.info(`terminating http${webServer.settings.secure ? 's' : ''} server on port ${webServer.settings.port}`);
            webServer.io.close();
            webServer.server.close();

            callback();
        } catch (e) {
            callback();
        }
    });

    adapter.on('ready', () => {
        if (adapter.config.auth) {
            // Generate secret for session manager
            adapter.getForeignObject('system.config', (err, obj) => {
                if (!err && obj) {
                    if (!obj.native || !obj.native.secret) {
                        obj.native = obj.native || {};
                        require('crypto').randomBytes(24, (ex, buf) => {
                            secret = buf.toString('hex');
                            adapter.extendForeignObject('system.config', {native: {secret: secret}});
                            main();
                        });
                    } else {
                        secret = obj.native.secret;
                        main();
                    }
                } else {
                    adapter.logger.error('Cannot find object system.config');
                }
            });
        } else {
            main();
        }
    });

    adapter.on('message', obj => {
        if (!obj || obj.command !== 'im') { // if not instance message
            return;
        }

        if (webServer && webServer.io) {
            // to make messages shorter, we code the answer as:
            // m - message type
            // s - socket ID
            // d - data

            webServer.io.publishInstanceMessageAll(obj.from, obj.message.m, obj.message.s, obj.message.d);
        }
    });

    adapter.on('log', obj =>
        webServer && webServer.io && webServer.io.sendLog(obj));

    return adapter;
}

function main() {
    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates((err, certificates, leConfig) => {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;
            webServer = initWebServer(adapter.config);
        });
    } else {
        webServer = initWebServer(adapter.config);
    }
}

function checkUser(username, password, cb) {
    username = (username || '').toString().replace(FORBIDDEN_CHARS, '_').replace(/\s/g, '_').replace(/\./g, '_').toLowerCase();

    if (bruteForce[username] && bruteForce[username].errors > 4) {
        let minutes = Date.now() - bruteForce[username].time;
        if (bruteForce[username].errors < 7) {
            if (Date.now() - bruteForce[username].time < 60000) {
                minutes = 1;
            } else {
                minutes = 0;
            }
        } else
        if (bruteForce[username].errors < 10) {
            if (Date.now() - bruteForce[username].time < 180000) {
                minutes = Math.ceil((180000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else
        if (bruteForce[username].errors < 15) {
            if (Date.now() - bruteForce[username].time < 600000) {
                minutes = Math.ceil((600000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else
        if (Date.now() - bruteForce[username].time < 3600000) {
            minutes = Math.ceil((3600000 - minutes) / 60000);
        } else {
            minutes = 0;
        }

        if (minutes) {
            return cb(`Too many errors. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, false);
        }
    }

    adapter.checkPassword(username, password, res => {
        if (!res) {
            bruteForce[username] = bruteForce[username] || {errors: 0};
            bruteForce[username].time = Date.now();
            bruteForce[username].errors++;
        } else if (bruteForce[username]) {
            delete bruteForce[username];
        }

        if (res) {
            return cb(null, username);
        } else {
            return cb(null, false);
        }
    });
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//}
function initWebServer(settings) {
    const server = {
        app:       null,
        server:    null,
        io:        null,
        settings
    };

    settings.port = parseInt(settings.port, 10) || 0;

    if (settings.port) {
        if (settings.secure && !settings.certificates) {
            return null;
        }

        settings.crossDomain     = true;
        settings.ttl             = settings.ttl || 3600;
        settings.forceWebSockets = settings.forceWebSockets || false;

        if (settings.auth) {
            const session      = require('express-session');
            const AdapterStore = utils.commonTools.session(session, settings.ttl);
            // Authentication checked by server itself
            store = new AdapterStore({adapter: adapter});
        }

        adapter.getPort(settings.port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined, async port => {
            if (parseInt(port, 10) !== settings.port && !adapter.config.findNextPort) {
                adapter.log.error(`port ${settings.port} already in use`);
                return adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            }

            settings.port = port;

            try {
                if (typeof LE.createServerAsync === 'function')
                    server.server = await LE.createServerAsync((req, res) => {
                        res.writeHead(501);
                        res.end('Not Implemented');
                    }, settings, adapter.config.certificates, adapter.config.leConfig, adapter.log, adapter);
                else {
                    server.server = LE.createServer((req, res) => {
                        res.writeHead(501);
                        res.end('Not Implemented');
                    }, settings, adapter.config.certificates, adapter.config.leConfig, adapter.log);
                }
            } catch (err) {
                adapter.log.error(`Cannot create webserver: ${err}`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
            if (!server.server) {
                adapter.log.error(`Cannot create webserver`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }

            let serverListening = false;
            server.server.on('error', e => {
                if (e.toString().includes('EACCES') && port <= 1024) {
                    adapter.log.error(`node.js process has no rights to start server on the port ${port}.\n` +
                        'Do you know that on linux you need special permissions for ports under 1024?\n' +
                        'You can call in shell following scrip to allow it for node.js: "iobroker fix"'
                    );
                } else {
                    adapter.log.error(`Cannot start server on ${settings.bind || '0.0.0.0'}:${port}: ${e}`);
                }
                if (!serverListening) {
                    adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });

            // Start the web server
            server.server.listen(settings.port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined, () => {
                adapter.setState('info.connection', true, true);
                serverListening = true
            });

            server.io = new SocketWS(settings, adapter);
            server.io.start(server.server, ws, {userKey: 'connect.sid', checkUser, store, secret});
        });
    } else {
        adapter.log.error('port missing');
        adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
    }

    return server;
}

// If started as allInOne mode => return function to create instance
if (module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
