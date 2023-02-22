console.log('Starting...')
  chrome.app.window.create('main.html', {
    id: 'mainWindow',
    frame: 'none',
    bounds: {
      width: 440,
      height: 440,
    },
    minWidth: 440,
    minHeight: 200,
  });
  /**
   * Construct a new ServiceFinder. This is a single-use object that does a DNS
   * multicast search on creation.
   * @constructor
   * @param {function} callback The callback to be invoked when this object is
   *                            updated, or when an error occurs (passes string).
   */
  var ServiceFinder = function (callback) {
    this.callback_ = callback;
    this.byIP_ = {};
    this.byService_ = {};

    // Set up receive handlers.
    this.onReceiveListener_ = this.onReceive_.bind(this);
    chrome.sockets.udp.onReceive.addListener(this.onReceiveListener_);
    this.onReceiveErrorListener_ = this.onReceiveError_.bind(this);
    chrome.sockets.udp.onReceiveError.addListener(this.onReceiveErrorListener_);

    ServiceFinder.forEachAddress_(function (address, error) {
      if (error) {
        this.callback_(error);
        return true;
      }
      if (address.indexOf(':') != -1) {
        // TODO: ipv6.
        console.log('IPv6 address unsupported', address);
        return true;
      }
      console.log('Broadcasting to address', address);

      ServiceFinder.bindToAddress_(address, function (socket) {
        if (!socket) {
          this.callback_('could not bind UDP socket');
          return true;
        }
        // Broadcast on it.
        this.broadcast_(socket, address);
      }.bind(this));
    }.bind(this));

    // After a short time, if our database is empty, report an error.
    setTimeout(function () {
      if (!Object.keys(this.byIP_).length) {
        this.callback_('no mDNS services found!');
      }
    }.bind(this), 10 * 1000);
  };

  /**
   * Invokes the callback for every local network address on the system.
   * @private
   * @param {function} callback to invoke
   */
  ServiceFinder.forEachAddress_ = function (callback) {
    chrome.system.network.getNetworkInterfaces(function (networkInterfaces) {
      if (!networkInterfaces.length) {
        callback(null, 'no network available!');
        return true;
      }
      networkInterfaces.forEach(function (networkInterface) {
        callback(networkInterface['address'], null);
      });
    });
  };

  /**
   * Creates UDP socket bound to the specified address, passing it to the
   * callback. Passes null on failure.
   * @private
   * @param {string} address to bind to
   * @param {function} callback to invoke when done
   */
  ServiceFinder.bindToAddress_ = function (address, callback) {
    chrome.sockets.udp.create({}, function (createInfo) {
      chrome.sockets.udp.bind(createInfo['socketId'], address, 0,
        function (result) {
          callback((result >= 0) ? createInfo['socketId'] : null);
        });
    });
  };

  /**
   * Sorts the passed list of string IPs in-place.
   * @private
   */
  ServiceFinder.sortIps_ = function (arg) {
    arg.sort(ServiceFinder.sortIps_.sort);
    return arg;
  };
  ServiceFinder.sortIps_.sort = function (l, r) {
    // TODO: support v6.
    var lp = l.split('.').map(ServiceFinder.sortIps_.toInt_);
    var rp = r.split('.').map(ServiceFinder.sortIps_.toInt_);
    for (var i = 0; i < Math.min(lp.length, rp.length); ++i) {
      if (lp[i] < rp[i]) {
        return -1;
      } else if (lp[i] > rp[i]) {
        return +1;
      }
    }
    return 0;
  };
  ServiceFinder.sortIps_.toInt_ = function (i) { return +i };

  /**
   * Returns the services found by this ServiceFinder, optionally filtered by IP.
   */
  ServiceFinder.prototype.services = function (opt_ip) {
    var k = Object.keys(opt_ip ? this.byIP_[opt_ip] : this.byService_);
    k.sort();
    return k;
  };

  /**
   * Returns the IPs found by this ServiceFinder, optionally filtered by service.
   */
  ServiceFinder.prototype.ips = function (opt_service) {
    var k = Object.keys(opt_service ? this.byService_[opt_service] : this.byIP_);
    console.log(k);
    return ServiceFinder.sortIps_(k);
  };

  /**
   * Handles an incoming UDP packet.
   * @private
   */
  ServiceFinder.prototype.onReceive_ = function (info) {
    console.log(info);
    var getDefault_ = function (o, k, def) {
      (k in o) || false == (o[k] = def);
      return o[k];
    };

    // Update our local database.
    // TODO: Resolve IPs using the dns extension.
    var packet = DNSPacket.parse(info.data);
    var byIP = getDefault_(this.byIP_, info.remoteAddress, {});

    packet.each('an', 12, function (rec) {
      var ptr = rec.asName();
      var byService = getDefault_(this.byService_, ptr, {})
      byService[info.remoteAddress] = true;
      byIP[ptr] = true;
    }.bind(this));

    // Ping! Something new is here. Only update every 25ms.
    if (!this.callback_pending_) {
      this.callback_pending_ = true;
      setTimeout(function () {
        this.callback_pending_ = undefined;
        this.callback_();
      }.bind(this), 25);
    }
  };

  /**
   * Handles network error occured while waiting for data.
   * @private
   */
  ServiceFinder.prototype.onReceiveError_ = function (info) {
    this.callback_(info.resultCode);
    return true;
  }

  /**
   * Broadcasts for services on the given socket/address.
   * @private
   */
  ServiceFinder.prototype.broadcast_ = function (sock, address) {
    var packet = new DNSPacket();
    packet.push('qd', new DNSRecord('_services._dns-sd._udp.local', 12, 1));

    var raw = packet.serialize();
    chrome.sockets.udp.send(sock, raw, '224.0.0.251', 5353, function (sendInfo) {
      if (sendInfo.resultCode < 0)
        this.callback_('Could not send data to:' + address);
    });
  };

  ServiceFinder.prototype.shutdown = function () {
    // Remove event listeners.
    chrome.sockets.udp.onReceive.removeListener(this.onReceiveListener_);
    chrome.sockets.udp.onReceiveError.removeListener(this.onReceiveErrorListener_);
    // Close opened sockets.
    chrome.sockets.udp.getSockets(function (sockets) {
      sockets.forEach(function (sock) {
        chrome.sockets.udp.close(sock.socketId);
      });
    });
  }

  var tcpServer = chrome.sockets.tcpServer;
  var tcpSocket = chrome.sockets.tcp;
  var scanned = false;
  var finder;

  var scannedCallback = function (opt_error) {
    if (opt_error) {
      return console.warn(opt_error);
    }
    scanned = true;
  };


  var onReceive = async function (receiveInfo) {
    console.log("READ", receiveInfo);
    var socketId = receiveInfo.socketId;
    // Parse the request.
    var data = arrayBufferToString(receiveInfo.data);
    // we can only deal with GET requests
    if (data.indexOf("GET ") !== 0) {
      // close socket and exit handler
      destroySocketById(socketId);
      return;
    }

    var keepAlive = false;
    if (data.indexOf("Connection: keep-alive") != -1) {
      keepAlive = true;
    }
    console.log(data);
    scanned = false;
    finder = new ServiceFinder(scannedCallback);
    console.log(finder);
    while (!scanned) {
      await new Promise(r => setTimeout(r, 1000));
    }
    returnReaders(socketId, keepAlive);
  };

  function returnReaders(socketId, keepAlive) {
    var outer = finder.services();
    var inner = finder.ips();
    var content = stringToArrayBuffer(JSON.stringify(inner));
    var lines = [
      "HTTP/1.0 200 OK",
      "Content-length: " + content.length,
      "Content-type: application/json",
      "Access-Control-Allow-Origin: *",
      "Access-Control-Allow-Methods: GET, PUT, POST, DELETE, OPTIONS",
      "Access-Control-Max-Age: 3600",
      "Access-Control-Allow-Headers"
    ];
    if (keepAlive) {
      lines.push("Connection: keep-alive");
    }
    var header = stringToArrayBuffer(lines.join("\n") + "\n\n");
    var outputBuffer = new ArrayBuffer(header.byteLength + content.length);
    var view = new Uint8Array(outputBuffer);

    view.set(header, 0);
    view.set(content, header.byteLength);
    sendReplyToSocket(socketId, outputBuffer, keepAlive);
  }
  function stringToArrayBuffer(string) {
    var buffer = new ArrayBuffer(string.length);
    var view = new Uint8Array(buffer);
    for (var i = 0; i < string.length; i++) {
      view[i] = string.charCodeAt(i);
    }
    return view;
  }
  var arrayBufferToString = function (buffer) {
    var str = '';
    var uArrayVal = new Uint8Array(buffer);
    for (var s = 0; s < uArrayVal.length; s++) {
      str += String.fromCharCode(uArrayVal[s]);
    }
    return str;
  };
  var destroySocketById = function (socketId) {
    tcpSocket.disconnect(socketId, function () {
      tcpSocket.close(socketId);
    });
  };
  var sendReplyToSocket = function (socketId, buffer, keepAlive) {
    // verify that socket is still connected before trying to send data
    tcpSocket.getInfo(socketId, function (socketInfo) {
      if (!socketInfo.connected) {
        destroySocketById(socketId);
        return;
      }
      tcpSocket.setKeepAlive(socketId, keepAlive, 1, function () {
        if (!chrome.runtime.lastError) {
          tcpSocket.send(socketId, buffer, function (writeInfo) {
            console.log("WRITE", writeInfo);
            if (!keepAlive || chrome.runtime.lastError) {
              destroySocketById(socketId);
            }
          });
        } else {
          console.warn("chrome.sockets.tcp.setKeepAlive:", chrome.runtime.lastError);
          destroySocketById(socketId);
        }
      });
    });
  };
  var onAccept = function (acceptInfo) {
    tcpSocket.setPaused(acceptInfo.clientSocketId, false);
    if (acceptInfo.socketId != serverSocketId)
      return;
    console.log("ACCEPT", acceptInfo);
  };
  tcpServer.create({}, function (socketInfo) {
    serverSocketId = socketInfo.socketId;
    tcpServer.listen(serverSocketId, "127.0.0.1", 11718, 50, function (result) {
      console.log("LISTENING:", result);
      tcpServer.onAccept.addListener(onAccept);
      tcpSocket.onReceive.addListener(onReceive);
    });
  });
