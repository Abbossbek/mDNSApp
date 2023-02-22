console.log('Starting...')

var tcpServer = chrome.sockets.tcpServer;
var tcpSocket = chrome.sockets.tcp;
var readers = [];
var scanned = false;
var finder = new Browser(function (err) {
  if (err) {
    console.warn(err)
  }
});
// var finder;

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
 readers = [];
  // Browse for all _http._tcp services  
  finder.find(callback_, '_llrp._tcp');
  // finder = new ServiceFinder(scannedCallback);
  // console.log(finder);
  while (!scanned) {
    await new Promise(r => setTimeout(r, 1000));
  }
  returnReaders(socketId, keepAlive);
};
var callback_ = function (ret_err, result) {
  scanned = true;
  if (ret_err) {
    console.log(ret_err);
  }

  if (result) {
    readers.push(result);
    console.log('Found service: ' + JSON.stringify(result, null, 4));
  }
}
function returnReaders(socketId, keepAlive) {
  var content = stringToArrayBuffer(JSON.stringify(readers));
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
