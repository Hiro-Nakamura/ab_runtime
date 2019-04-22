const AB = require("ab-utils");
//const async = require("async");
const fs = require("fs");
const net = require("net");
const path = require("path");
const process_watch = require(path.join(__dirname, "src", "process_watch.js"));
const psLookup = require("current-processes");
const pidusage = require('pidusage')
const shell = require("shelljs");
//const _ = require("lodash");

// const SOCKETFILE = "1338";
// const SOCKETFILE = "/tmp/ab.sock";

let connections = {};
let server = null;
let currStream = null;

var isReportRunning = false;
var checkID = null;

// Net
// Connections to the running bot_manager in our swarm.
//
const config = AB.config("bot_manager");

var isSockConnection = true;
var SOCKETFILE = "/tmp/ab.sock";
var PORT = "1338";
var ACCESSTOKEN = "ThereIsN0Sp00n";
if (
  !config.hostConnection.sharedSock ||
  !config.hostConnection.sharedSock.path
) {
  isSockConnection = false;
  if (
    !config.hostConnection.tcp ||
    !config.hostConnection.tcp.port ||
    !config.hostConnection.tcp.accessToken
  ) {
    console.error(
      "ERROR: config/local.js must specify a bot_manager.hostConnection."
    );
    process.exit(1);
  }
}
if (isSockConnection) {
  SOCKETFILE = config.hostConnection.sharedSock.path;
} else {
  PORT = config.hostConnection.tcp.port;
  ACCESSTOKEN = config.hostConnection.tcp.accessToken;
}

/**
 * checkRunning
 * A repeated check to see if all services are up and running.
 * it performs a : docker service ls
 * and scans stdout to see if any of the service report 0/x
 * If everything seems to be running, a "__running" message is sent
 * to our connected botManager.
 * If a downed service is detected, then a "__offline:[service,...]"
 * is sent to our connected botManager.
 */
var downCheck = /0\/\d/;
var parseLine = /(\w+)\s+(\w+)\s+\w+\s+0\/\d+\s+([\w\/:-]+)/g;
// ID                  NAME                MODE                REPLICAS            IMAGE                           PORTS
// h8bx5qewkeaq        ab_apiSails         replicated          1/1                 skipdaddy/ab-api-sails:master   *:1337->1337/tcp
// parseLine 1:ID,  2:Name,  3:Image
function checkRunning() {
  // make sure our connection to our botManager is ok before trying:
  if (currStream && !currStream.destroyed) {
    shell.exec("docker service ls", (code, stdout, stderr) => {
      if (code == 0) {
        if (stdout.search(downCheck) == -1) {
          if (isReportRunning) {
            console.log("... looks like server is running.");
            currStream.write("__running");
            isReportRunning = false;
          }
        } else {
          var lines = stdout.split("\n");
          var offlineContainers = [];
          lines.forEach(l => {
            var match = parseLine.exec(l);
            if (match) {
              offlineContainers.push(
                `${match[2]}`); // ${match[2]}(${match[3]})
            }
          });
          if (offlineContainers.length > 0) {
            currStream.write("__offline:" + offlineContainers.join(","));
            isReportRunning = true;
          }
        }
      }
    });
  } else {
    console.log("connection to botManager is not active.");
  }
}

function createServer(socket) {
  console.log("Creating server.");
  var server = net
    .createServer(function (stream) {
      console.log("Connection acknowledged.");
      currStream = stream;

      // Now that currStream is updated, send update to process_watch
      // pass in ps and pid checker libraries, and the new stream
      process_watch.init(psLookup, pidusage, currStream)

      stream._sentValidToken = false;

      // Store all connections so we can terminate them if the server closes.
      // An object is better than an array for these.
      var self = Date.now();
      connections[self] = stream;
      stream.on("end", function () {
        console.log("Client disconnected.");
        delete connections[self];
      });

      // Messages are buffers. use toString
      stream.on("data", function (msg) {
        msg = msg.toString();

        console.log("Client:", msg);

        // verify access token if necessary
        if (!isSockConnection && !stream._sentValidToken) {
          if (msg == ACCESSTOKEN) {
            stream._sentValidToken = true;
            console.log("... accessToken accepted.");
          } else {
            console.log("... accessToken REJECTED!");
          }
        } else {
          // else execute a command:
          shell.exec(msg, (code, stdout, stderr) => {
            // console.log("code:", code);
            // console.log("stdout:", stdout);
            // console.log("stderr:", stderr);

            // indicate we need to report when everything is running
            isReportRunning = true;
            stream.write("__done"); // command is done
          });
        }
      });
    })
    .listen(socket)
    .on("connection", function (socket) {
      console.log("Client connected.");
    });
  return server;
}

// manage unix socket:
console.log("Checking for leftover socket.");
fs.stat(SOCKETFILE, function (err, stats) {
  if (err) {
    // start server
    console.log("No leftover socket found.");
    server = createServer(isSockConnection ? SOCKETFILE : PORT);
    return;
  }
  // remove file then start server
  console.log("Removing leftover socket.");
  fs.unlink(SOCKETFILE, function (err) {
    if (err) {
      // This should never happen.
      console.error(err);
      process.exit(0);
    }
    server = createServer(isSockConnection ? SOCKETFILE : PORT);
    return;
  });
});

// now setup our checkRunning() operation
setInterval(checkRunning, 5 * 1000);

// now setup our checkUsage() operation
setInterval(process_watch.checkProcess, 60 * 1000); // 1 min
setInterval(process_watch.reportHighUsageProcess, 30 * 60 * 1000); // 30 min
