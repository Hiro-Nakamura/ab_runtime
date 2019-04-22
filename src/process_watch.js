/**
 * Docker system process_watcher
 *
 * @description :: Server-side logic for running stateful checks 
 *                  on all processes on base operating system.
 *               How often checks are run is determined by source
 *               Source must pass "current-processes" and "pidusage" modules
 */

var psLookup;
var pidusage;
const _ = require("lodash");
// Functions output to this stream for reporting
// Socket connection to the Bot_manager service.
var currStream;
/* List rules;
 * if above {cpuAddLevel} go in here
 * if drop below {cpuRemoveLevel} remove
 * if not detected above {cpuAddLevel} for a {deleteInterval} remove
 * 
 * [ {watchEntry},...]
 * where {watchEntry} is:
 * [{
 * pid : {string} the uid of the running process, 
 * lastDetectTime : last time detected - updates on check process
 * }]
 */
var processWatchList = []

/* 
 * [ {warnEntry},...]
 * where {warnEntry} is:
 * [{
 *   pid : {string} the uid of the running process, 
 *   name : {string} name of the process, 
 *   cpu : {int}  value of % cpu usage, 
 *   memory : {int} value of memory usage,
 *   reportTime : made first save & updated when process is reported. Stops spammy reports, but allows reporting after {reportInterval},
 *   lastDetectTime : last time detected - updates on check process,
 *   firstDetectTime : tracks first time a ps was put in Warn list, helps dev see age of ps
 * }]
 */
var processWarnList = [];

/* 
 * Both of these cpu values will be modified 
 * to be .00 types, if the top cpu values are <1
 */
// if x < is ok
var cpuRemoveLevel = 25;
//if x > track it
var cpuAddLevel = 50;

// If ps is last detected {deleteInterval} ago, remove from lists
var deleteInterval = (3 * 60 * 60 * 1000); // 3 hours
// re-report interval ; (a NEW warn list item is reported after 15 min)
var reportInterval = (90 * 60 * 1000); // 90 min

/**
 * writeToSlack
 * @param {string} Message for Slack
 * Beginning of message marked by ':'
 * Only one 'report' written at a time, 'botMessage' resets.
 */
function writeToSlack(message) {
  if (currStream) {
    currStream.write("__alert:" + message);
  }
}
/**
 * updateCPUTestValues
 * @param {number} cpuValue single cpu value from a current process
 * cpu type check
 * Passed in value will be from The first top-usage process
 * If value <=1 we know it's a unix style OS
 */


function updateCPUTestValues(cpuValue) {
  if ((cpuRemoveLevel < 1) && (cpuAddLevel < 1)) {
    //already modified
    return null;
  } else if (cpuValue <= 1) {
    // change 1 to .01
    cpuRemoveLevel = (cpuRemoveLevel / 100);
    cpuAddLevel = (cpuAddLevel / 100);
    cpuTypeChecked = true;
  }
  cpuTypeChecked = true;
}
/**
 * cleanList
 * @param {array} processes list of currently running processes on server
 * @param {dateTime} currentTime (optional) timestamp used to calculate current age of process.
 * Cleans 'warn' and 'watch' lists
 * if older than 'deleteInterval' 
 * or 
 * if drop below 'cpuRemoveLevel'
 * or
 * if process doesn't exist anymore
 */
function cleanList(processes, currentTime = new Date().getTime()) {
  // If processes last reported {deleteInterval} ago
  // Remove from Lists
  _.remove(processWatchList, function (ele) {
    return (ele.lastDetectTime <= (currentTime - deleteInterval));
  });
  _.remove(processWarnList, function (ele) {
    return (ele.lastDetectTime <= (currentTime - deleteInterval));
  });

  // if process, in current report
  // drops below {cpuRemoveLevel} OR does not exist
  // Remove from Lists 
  _.remove(processWarnList, function (listEntry) {
    var isNotFound = true;

    function isBelowCPULevel(processes) {
      // isBelowCPULevel should only return {true} if it is the
      // current listEntry and we want to remove it.

      // if this is our current listEntry
      if (processes.pid == listEntry.pid) {

        // mark we found it
        isNotFound = false;

        // check if it is below our cpuRemoveLevel
        return (processes.cpu < cpuRemoveLevel);
      }
      return false;
    }

    // remove this entry if it isBelowCPULevel OR it wasn't found
    return (processes.some(isBelowCPULevel).length > 0 || isNotFound);
  })

  _.remove(processWatchList, function (listEntry) {
    var isNotFound = true;

    function isBelowCPULevel(processes) {
      // isBelowCPULevel should only return {true} if it is the
      // current listEntry and we want to remove it.

      // if this is our current listEntry
      if (processes.pid == listEntry.pid) {

        // mark we found it
        isNotFound = false;

        // check if it is below our cpuRemoveLevel
        return (processes.cpu < cpuRemoveLevel);
      }
      return false;
    }

    // remove this entry if it isBelowCPULevel OR it wasn't found
    return (processes.some(isBelowCPULevel).length > 0 || isNotFound);
  })
}
/**
 * toMinutes
 * @param {int} miliseconds
 * the difference between two timestamps 
 * int to be converted to a human readable number
 */
function toMinutes(millis) {
  var minutes = Math.floor(millis / 60000);
  var seconds = ((millis % 60000) / 1000).toFixed(0);
  return minutes + "." + (seconds < 10 ? '0' : '') + seconds;
}
/**
 * formatBytes
 * @param {int} number of bytes
 * @param {int} null option to be more precise
 * int to be converted to a bytes string. 
 */
function formatBytes(bytes, decimals) {
  if (bytes == 0) return '0 Bytes';
  var k = 1024,
    dm = decimals <= 0 ? 0 : decimals || 2,
    sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
    i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
/**
 * recordWarnProcess
 * @param {obj} processObject
 * the report object sent by checkProcess.
 * @param {datetime} currentTime
 * the current time, sent by checkProcess.
 */
function recordWarnProcess(processObject, currentTime) {

  var pidStored = function (stored) {
    if (stored == undefined) {
      return false;
    }
    return processObject.pid == stored.pid;
  };
  let found = 0;
  pidusage(processObject.pid, function (err, stats) {
    // all processes always get updated with this information
    processObject.elapsed = toMinutes(stats.elapsed);
    processObject.memory = formatBytes(stats.memory);
  })
  if (processWarnList.some(pidStored)) {

    //if exists in storage
    // update; cpu, memory, lastDetectTime, 

    //element.lastDetectTime <= (currentTime - reportInterval)
    index = _.findIndex(processWarnList, function (element) {
      return element.pid == processObject.pid
    })
    /* 
     * found time, Show how long a ps has been on list
     *     age is difference between found and current time 
     * reportTime, Show how long since last report
     * 
     * If a new process, that is repeat offender, 
     *     IF Also a little over 15 min old 
     *         report == true
     */
    processWarnList[index].report = ((processWarnList[index].reportTime ==
      undefined) && (
      processWarnList[index].firstDetectTime <= (currentTime - 15 * 60 *
        1000)));
    //update previous
    processWarnList[index].lastDetectTime = currentTime;
    processWarnList[index].elapsed = processObject.elapsed;
    processWarnList[index].memory = processObject.memory;
    processWarnList[index].cpu = processObject.cpu;
  } else {
    processObject.lastDetectTime = currentTime;
    processObject.firstDetectTime = currentTime;
    processObject.report = false;
    processWarnList.push(processObject);
  }
}

module.exports = {
  /**
   * init
   * @param {arr} ps current-processes npm module
   * @param {arr} pid pidusage npm module
   * @param {steam} output stream for reports. Usually Slack. STDout for testing
   * bring in the process watching modules
   * AND the stream for output to Slack
   */
  init: function (ps, pid, stream) {
    psLookup = ps;
    pidusage = pid;
    currStream = stream;
  },

  /**
   * checkProcess
   * @param {datetime} currentTime used track in lists when 'new' and when 'updated'
   * On first new run we check cpu type
   * 
   * new cpuAddLevel processes are added to Watch list
   * If a  PID 'match' is in Watch already, process is added to Warn list
   * 
   * If tracked process is above cpuAddLevel, it's 'last detected' timestamp is updated
   * If a process is below cpuAddLevel, it can eventually age out of the list
   * 
   * 'cleanList' is then run with 'processes,' a current snapshot of all processes.
   */
  checkProcess: function checkProcess(currentTime = new Date().getTime()) {
    // stops function from crashing server if init hasn't been run
    if (!psLookup) {
      console.log("process_watch not initialized");
      return null;
    }
    //boolean to help us only run check once
    let cpuTypeChecked = false;
    psLookup.get(function (err, processes) {
      if (err) {
        console.err(err);
        return (err);
      }

      var sorted = _.sortBy(processes, "cpu");
      let top5 = sorted.reverse().splice(0, 5);
      top5.forEach(element => {
        // tests need to match what OS returns for cpu
        // 25 or .25
        if (!cpuTypeChecked) {
          updateCPUTestValues(element.cpu);
        }

        // check if high CPU offender before running log updates
        if (element.cpu >= cpuAddLevel) {
          var match = function (stored) {
            if (stored === undefined) {
              return false;
            }
            if (element.pid == stored.pid) {
              //if already in list
              //update stored information
              stored.cpu = element.cpu;

              // Note how lastDetectTime is only updated to current time 
              // IF the cpu is above {addLevel}
              stored.lastDetectTime = currentTime;

              //confirm exists
              return element.pid == stored.pid;
            }
          };
          let history = processWatchList.some(match);

          // Note how by inserting to warnlist First, 
          // a brand new process will Not be in watchlist yet
          // thus needing a second infraction before Warned about

          // check if process in watch list 
          if (history) {
            // detected new high usage process
            recordWarnProcess(element, currentTime);
          }

          // check if already in watch list 
          if (!history) {
            // adding to processWatchList
            processWatchList.push({
              name: element.name,
              pid: element.pid,
              cpu: element.cpu,
              lastDetectTime: currentTime
            });
          }
        }
      });
      cleanList(processes, currentTime)
    });

  },

  /**
   * reportHighUsageProcess
   * @param {datetime} currentTime used to calculate if if an older report needs to be re-sent
   * sends process statistics to Slack channel
   * if New or reportInterval old
   * 
   * updates .reportTime. 
   * sends individual reports to slack
   * returns fullReport for unit testing 
   */
  reportHighUsageProcess: function reportHighUsageProcess(currentTime =
    new Date().getTime()) {

    // clean duplicates
    processWarnList = _.uniqBy(processWarnList, 'pid');
    // default message
    let fullReport = `issues exist`;
    if (processWarnList.length > 0) {
      let botMessage = ``;
      let sorted = _.sortBy(processWarnList, "cpu");
      //can limit how many processes are reported in this splice
      processWarnList = sorted.reverse().splice(0, 20);
      processWarnList.forEach(element => {

        // if not removed from warn list, re-warn afer {reportInterval}
        let reWarnTime = (element.reportTime <= (currentTime -
          reportInterval)); //
        if (reWarnTime || (element.report)) {
          // this message cannot contain ':' characters
          // should be 'botMessage ='...
          //reset after each message
          botMessage = (`\nThis process may be problematic \n` +
            element
            .name +
            //convert .1 to 10 for ease of reading
            ` CPU usage ` + ((element.cpu <= 1) ? element.cpu *
              100 :
              element.cpu) +
            `, memory usage ` + formatBytes(element.memory) +
            `, last detected ` + toMinutes(Math.abs(currentTime -
              element
              .lastDetectTime)) +
            ` min ago, pid ` + element.pid +
            `, first logged ` + toMinutes(Math.abs(currentTime -
              element.firstDetectTime)) + ` ago.`
          );
          // Uncomment after making tests
          element.report = false;
          element.reportTime = currentTime;
          fullReport += botMessage;
          writeToSlack(botMessage)
        }
      });
    } else {
      //Don't writeTo slack if there's no issues!
      return ('no issues')
    }
    // either 'some issues' or the full report will be returned here
    return (fullReport);
  },
  /**
   * reportProcesses
   * returns watch list
   * Only used for unit testing insert/drop logic
   */
  reportProcesses: function reportProcesses() {
    if (processWatchList.length > 0) {
      return processWatchList;
    } else {
      return undefined;
    }
  },
}
