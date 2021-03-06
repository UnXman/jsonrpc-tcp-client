/*
 * http://www.jsonrpc.org/specification
 *
 * Warning:
 *  Batch is not implemented.
 *  Server is not fully implemented.
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var events = require("events");
var net = require("net");
var json_stream_1 = require("json-stream");
var CBuffer = require("CBuffer");
var defaultOptions = {
    connectTimeout: 10e3,
    maxBuffered: 100,
    connectImmediately: false,
    socketEncoder: function (obj) {
        return new Buffer(JSON.stringify(obj) + "\n");
    },
    retryDelay: 100
};
function mergeOptions(options) {
    var res = {};
    for (var key in defaultOptions) {
        if (defaultOptions.hasOwnProperty(key)) {
            res[key] = defaultOptions[key];
        }
    }
    if (options != null) {
        for (var key in options) {
            if (options.hasOwnProperty(key)) {
                res[key] = options[key];
            }
        }
    }
    return res;
}
var ReconnectSocket = (function (_super) {
    __extends(ReconnectSocket, _super);
    function ReconnectSocket(cache, port, options) {
        var _this = this;
        _super.call(this);
        this.cache = cache;
        this.port = port;
        this.close = function () {
            _this.closed = true;
            if (_this.socket) {
                _this.socket.end();
                _this.socket.unref();
            }
        };
        this.connect = function () {
            if (_this.socket || _this.closed) {
                return;
            }
            var socket = net.createConnection(_this.port, _this.options.host);
            _this.socket = socket;
            socket.on("connect", _this.onSocketConnect);
            var onError = function () {
                if (_this.socket !== socket) {
                    return;
                }
                _this.socketConnected = false;
                delete _this.sendingIndex;
                delete _this.sendingObj;
                socket.destroy();
                delete _this.socket;
                if (!_this.closed) {
                    setTimeout(_this.connect, _this.options.retryDelay);
                }
            };
            socket.on("error", onError);
            socket.on("close", onError);
            socket.on("end", onError);
            socket.on("drain", _this.onSocketDrain);
            socket.on("data", function (data) {
                _this.emit("data", data);
            });
        };
        this.onSocketConnect = function () {
            delete _this.sendingIndex;
            delete _this.sendingObj;
            _this.socketConnected = true;
            _this.emit("connect");
            _this.send();
        };
        this.onSocketDrain = function () {
            delete _this.paused;
            _this.send();
        };
        this.options = mergeOptions(options);
        if (this.options.connectImmediately) {
            this.connect();
        }
    }
    ReconnectSocket.prototype.send = function () {
        if (this.cache.size <= 0) {
            return;
        }
        while (true) {
            if (this.paused) {
                return;
            }
            if (this.socketConnected) {
                if (this.sendingIndex == null) {
                    this.sendingIndex = 0;
                    this.sendingObj = this.cache.get(0);
                }
                else {
                    var index = this.sendingIndex;
                    if (index >= this.cache.size) {
                        index = this.cache.size - 1;
                    }
                    // find the real index since cache may be shifted
                    while (index >= 0) {
                        if (this.cache.get(index) === this.sendingObj) {
                            break;
                        }
                        --index;
                    }
                    if (index >= 0) {
                        this.sendingIndex = index;
                        this.emit("sent", this.sendingObj);
                    }
                    else {
                        delete this.sendingIndex;
                        delete this.sendingObj;
                    }
                    // skip done ones
                    while (true) {
                        ++index;
                        if (index >= this.cache.size) {
                            return;
                        }
                        this.sendingIndex = index;
                        this.sendingObj = this.cache.get(index);
                        if (this.sendingObj.done) {
                            continue;
                        }
                        break;
                    }
                }
                if (this.sendingObj.buf == null) {
                    this.sendingObj.buf = this.options.socketEncoder(this.sendingObj.obj);
                }
                if (!this.socket.write(this.sendingObj.buf, "buffer")) {
                    this.paused = true;
                }
            }
            else {
                this.connect();
                return;
            }
        }
    };
    return ReconnectSocket;
}(events.EventEmitter));
exports.ReconnectSocket = ReconnectSocket;
var Client = (function () {
    function Client(port, options) {
        var _this = this;
        this.port = port;
        this.id = 1;
        this.whenOverflow = function (sendingObj) {
            if (sendingObj.done) {
                return;
            }
            if (sendingObj.cb) {
                sendingObj.cb({ code: -32000, message: "Overflow" });
            }
        };
        this.options = mergeOptions(options);
        this.cache = new CBuffer(this.options.maxBuffered);
        this.cache.overflow = this.whenOverflow;
        this.socket = new ReconnectSocket(this.cache, port, this.options);
        this.socket.on("connect", function () {
            if (_this.jsonStream) {
                _this.jsonStream.end();
                _this.jsonStream.removeAllListeners();
                delete _this.jsonStream;
            }
            _this.jsonStream = new json_stream_1.JSONStream;
            _this.jsonStream.on("data", function (obj) {
                _this.response(obj);
            });
        });
        this.socket.on("data", function (data) {
            if (_this.jsonStream) {
                _this.jsonStream.write(data);
            }
        });
        this.socket.on("sent", function (sendingObj) {
            if (sendingObj.obj.id == null) {
                sendingObj.done = true;
            }
        });
    }
    Client.prototype.request = function (method, params, cb) {
        var req = { method: method };
        var id;
        if (cb) {
            // if has cb, will send Request with id
            id = this.id++;
            req.id = id;
        }
        if (params) {
            req.params = params;
        }
        if (this.options.jsonrpc) {
            req.jsonrpc = this.options.jsonrpc;
        }
        if (cb) {
            this.cache.push({
                id: id,
                obj: req,
                cb: cb
            });
        }
        else {
            this.cache.push({ obj: req });
        }
        this.socket.send();
    };
    Client.prototype.response = function (obj) {
        if (obj == null || obj.id == null) {
            return;
        }
        var id = obj.id;
        // callback
        var index = 0;
        while (index < this.cache.size) {
            var sendingObj = this.cache.get(index);
            if (sendingObj.id === id) {
                if (sendingObj.cb) {
                    sendingObj.cb(obj.error, obj.result);
                }
                sendingObj.done = true;
                break;
            }
            ++index;
        }
        // purge done ones
        while (this.cache.size > 0) {
            if (this.cache.first().done) {
                this.cache.shift();
            }
            else {
                break;
            }
        }
    };
    Client.prototype.close = function () {
        this.socket.close();
    };
    return Client;
}());
exports.Client = Client;
var Server = (function () {
    function Server(port, options) {
        var _this = this;
        this.port = port;
        this.sockets = [];
        this.methods = {};
        this.options = mergeOptions(options);
        this.server = net.createServer(function (socket) {
            _this.sockets.push(socket);
            var closed;
            var jsonStream = new json_stream_1.JSONStream;
            jsonStream.on("data", function (req) {
                if (req == null || closed) {
                    return;
                }
                var method = _this.methods[req.method];
                if (method == null && req.id != null) {
                    _this.send(socket, { id: req.id, error: { code: -32601, message: "Method not found" } });
                    return;
                }
                var resp = function (error, result) {
                    if (closed || req.id == null) {
                        return;
                    }
                    if (error) {
                        if (typeof error !== "object") {
                            error = { data: error };
                        }
                        if (error.code == null) {
                            error.code = -32603;
                        }
                        if (error.message == null) {
                            error.message = "Internal error";
                        }
                        _this.send(socket, { id: req.id, error: error });
                        return;
                    }
                    if (result == null) {
                        result = null;
                    }
                    _this.send(socket, { id: req.id, result: result });
                    return;
                };
                try {
                    method(req.params, resp);
                }
                catch (exc) {
                    resp({ data: { exc: { code: exc.code, msg: exc.message, stack: exc.stack } } });
                }
            });
            socket.pipe(jsonStream);
            var onError = function () {
                if (closed) {
                    return;
                }
                closed = true;
                socket.destroy();
                var index = _this.sockets.indexOf(socket);
                if (index >= 0) {
                    _this.sockets.splice(index, 1);
                }
            };
            socket.on("error", onError);
            socket.on("close", onError);
            socket.on("end", onError);
        });
    }
    Server.prototype.register = function (method, cb) {
        this.methods[method] = cb;
    };
    Server.prototype.send = function (socket, obj) {
        socket.write(JSON.stringify(obj) + "\n");
    };
    Server.prototype.start = function () {
        this.server.listen(this.port, function () {
        });
    };
    Server.prototype.close = function (cb) {
        this.server.close(cb);
        this.server.unref();
        for (var _i = 0, _a = this.sockets; _i < _a.length; _i++) {
            var socket = _a[_i];
            socket.destroy();
        }
        this.sockets = [];
    };
    return Server;
}());
exports.Server = Server;
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Client;
//# sourceMappingURL=index.js.map