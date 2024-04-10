'use strict';

const util = require('util');
const dgram = require('dgram');
const EventSource = require('eventsource');

const HUE_REMOTE_ADDR = process.env.GOVEEHUE_HUE_HOST;
const HUE_MOTION_ID = ['cb2c4767-3562-43f4-85d8-cf50dd65adf3', 'b6f76faf-99b5-4682-991e-2cf20345af8a'];
const HUE_LIGHTL_ID = ['d717eaac-06d6-4ab8-aec8-26b9bed04e62', '90b94f3d-5691-4e07-93b6-602fec9af8cd'];
const HUE_BUTTON_ID = 'b9d6fd53-c031-48ce-a736-6b9cf15f143e';
const HUE_API_KEY = process.env.GOVEEHUE_HUE_KEY;
const GOVEE_LOCAL_PORT = 4002;
const GOVEE_REMOTE_ADDR = process.env.HUE_REMOTE_ADDR;
const GOVEE_REMOTE_PORT = 4003;
const GOVEE_MULTICAST_ADDR = '239.255.255.250';
const GOVEE_MULTICAST_PORT = 4001;
const GOVEE_ON_TIME = 2 * 60 * 1000;

let goveeSocket = null;
let goveeStatus = null;
let hueEventSource = null;
let motionReports = HUE_MOTION_ID.map(() => null);
let lightLevelReports = HUE_LIGHTL_ID.map(() => null);
let buttonReport = null;
let lastOnAt = 0;
let manualOverride = false;
let onNextGoveeStatus = null;

const consoleError = console.error;
const consoleLog = console.log;

console.error = (...args) => consoleError.apply(console, [new Date().toLocaleString(), ...args]);
console.log = (...args) =>
{
  args.unshift(new Date().toLocaleString(), goveeStatus?.onOff ? 'ON ' : 'OFF');

  consoleLog.apply(console, args);
};

main();

async function main()
{
  await setUpGovee();
  setInterval(requestGoveeStatus, 666);
  await setUpHue();
  await fetchMotionReport();
  await fetchLightLevelReport();
}

function setUpGovee()
{
  console.log(`Setting up Govee...`);

  return new Promise((resolve, reject) =>
  {
    goveeSocket = dgram.createSocket('udp4');

    goveeSocket.bind(GOVEE_LOCAL_PORT);

    goveeSocket.on('listening', async () =>
    {
      goveeSocket.addMembership(GOVEE_MULTICAST_ADDR);
      requestGoveeStatus();
      resolve();
    });

    goveeSocket.once('error', err =>
    {
      console.log(`[GOVEE] ${err.message}`);
      setTimeout(setUpGovee, 1000);
      resolve();
    });

    goveeSocket.on('message', data =>
    {
      handleGoveeMessage(JSON.parse(data).msg);
    });
  });
}

function setUpHue()
{
  console.log('Settip up Hue...');

  hueEventSource = new EventSource(`https://${HUE_REMOTE_ADDR}/eventstream/clip/v2`, {
    headers: {'hue-application-key': HUE_API_KEY},
    https: {rejectUnauthorized: false}
  });

  hueEventSource.onmessage = e =>
  {
    JSON.parse(e.data).forEach(event =>
    {
      if (event.type === 'update')
      {
        event.data.forEach(update =>
        {
          if (HUE_MOTION_ID.includes(update.id))
          {
            handleMotionSensorUpdate(update);
          }
          if (HUE_LIGHTL_ID.includes(update.id))
          {
            handleLightLevelUpdate(update);
          }
          else if (update.id === HUE_BUTTON_ID)
          {
            handleButtonUpdate(update);
          }
        });
      }
    });
  };

  hueEventSource.onerror = err =>
  {
    console.error(`[HUE] ${err.message}`);
  };
}

async function fetchMotionReport()
{
  console.log('Fetching the current motion report...');

  try
  {
    for (const motionId of HUE_MOTION_ID)
    {
      const res = await fetch(`https://${HUE_REMOTE_ADDR}/clip/v2/resource/motion/${motionId}`, {
        headers: {'hue-application-key': HUE_API_KEY}
      });
      const data = await res.json();

      handleNewMotionReport(motionId, data.data[0].motion.motion_report);
    }
  }
  catch (err)
  {
    console.error(`[HUE] Failed to fetch the motion report: ${err.message}`);
  }
}

async function fetchLightLevelReport()
{
  console.log('Fetching the current light level report...');

  try
  {
    for (const lightLevelId of HUE_LIGHTL_ID)
    {
      const res = await fetch(`https://${HUE_REMOTE_ADDR}/clip/v2/resource/light_level/${lightLevelId}`, {
        headers: {'hue-application-key': HUE_API_KEY}
      });
      const data = await res.json();

      handleLightLevelUpdate(data.data[0]);
    }
  }
  catch (err)
  {
    console.error(`[HUE] Failed to fetch the light level report: ${err.message}`);
  }
}

function inspect(value)
{
  console.log(util.inspect(value, {depth: 999, colors: true}));
}

function handleMotionSensorUpdate(data)
{
  const newMotionReport = data?.motion?.motion_report;

  if (!newMotionReport)
  {
    return;
  }

  handleNewMotionReport(data.id, newMotionReport);
}

function handleLightLevelUpdate(data)
{
  const newLightLevelReport = data?.light?.light_level_report;

  if (!newLightLevelReport)
  {
    return;
  }

  const i = HUE_LIGHTL_ID.indexOf(data.id);
  const oldLightLevelReport = lightLevelReports[i];

  if (JSON.stringify(newLightLevelReport) === JSON.stringify(oldLightLevelReport))
  {
    return;
  }

  lightLevelReports[i] = newLightLevelReport;

  console.log(`Light level ${i}:`, newLightLevelReport);
}

function handleButtonUpdate(data)
{
  const newButtonReport = data?.button?.button_report;

  if (!newButtonReport)
  {
    return;
  }

  handleNewButtonReport(newButtonReport);
}

function handleNewMotionReport(motionId, newMotionReport)
{
  if (!newMotionReport.motion)
  {
    newMotionReport.changed = new Date(Date.parse(newMotionReport.changed) - 10 * 1000).toISOString()
  }

  const i = HUE_MOTION_ID.indexOf(motionId);
  const oldMotionReport = motionReports[i];

  if (JSON.stringify(newMotionReport) === JSON.stringify(oldMotionReport))
  {
    return;
  }

  motionReports[i] = newMotionReport;

  scheduleHandleMotionChange();

  console.log(`Motion ${i}:`, newMotionReport);
}

function handleNewButtonReport(newButtonReport)
{
  if (newButtonReport.event !== 'initial_press')
  {
    return;
  }

  if (JSON.stringify(newButtonReport) === JSON.stringify(buttonReport))
  {
    return;
  }

  buttonReport = newButtonReport;

  scheduleHandleButtonChange();

  console.log(`Button:`, buttonReport);
}

function scheduleHandleMotionChange(delay = 1)
{
  clearTimeout(handleMotionChange.timer);
  handleMotionChange.timer = setTimeout(handleMotionChange, delay);
}

function scheduleHandleButtonChange(delay = 1)
{
  clearTimeout(handleButtonChange.timer);
  handleButtonChange.timer = setTimeout(handleButtonChange, delay);
}

function handleMotionChange()
{
  const reports = motionReports.filter(r => !!r);

  if (!reports.length)
  {
    return;
  }

  const reportWithMotionI = reports.findIndex(r => r.motion);

  if (reportWithMotionI !== -1)
  {
    if (lightLevelReports[reportWithMotionI]?.light_level <= 8500)
    {
      turnGovee(true);
      scheduleHandleMotionChange(GOVEE_ON_TIME * 2);
    }

    return;
  }

  const latestChanged = Math.max(...motionReports.map(r => r ? Date.parse(r.changed) : 0));
  const timeDiff = Date.now() - latestChanged;

  if (timeDiff < GOVEE_ON_TIME)
  {
    return scheduleHandleMotionChange(timeDiff + 1);
  }

  if (!manualOverride)
  {
    turnGovee(false);
  }

  scheduleHandleMotionChange(GOVEE_ON_TIME * 2);
}

function handleButtonChange()
{
  if (!buttonReport || !goveeStatus)
  {
    return;
  }

  if (goveeStatus.onOff)
  {
    console.log('Disabling manual override...');

    manualOverride = false;

    turnGovee(false);

    return;
  }

  console.log('Enabling manual override...');

  manualOverride = true;

  turnGovee(true);
}

function sendGovee(msg, port, addr)
{
  if (!goveeSocket)
  {
    return;
  }

  if (!port)
  {
    port = GOVEE_REMOTE_PORT;
  }

  if (!addr)
  {
    addr = GOVEE_REMOTE_ADDR;
  }

  goveeSocket.send(JSON.stringify(msg), port, addr);
}

function turnGovee(state)
{
  if (state)
  {
    console.log(`Turning Govee on...`);

    lastOnAt = Date.now();
  }
  else if (lastOnAt)
  {
    console.log(`Turning Govee off after ${Math.round((Date.now() - lastOnAt) / 1000)}s...`);

    lastOnAt = 0;
  }

  sendGovee({
    msg: {
      cmd: 'turn',
      data: {
        value: state ? 1 : 0
      }
    }
  });
}

function requestGoveeStatus()
{
  if (!goveeSocket)
  {
    return;
  }

  sendGovee({
    msg: {
      cmd: 'devStatus',
      data: {}
    }
  });

  requestGoveeStatus.lastAt = Date.now();
}

function handleGoveeMessage(msg)
{
  if (msg.cmd !== 'devStatus')
  {
    return;
  }

  const oldStatus = goveeStatus;

  goveeStatus = msg.data;
  goveeStatus.ts = Date.now();
  goveeStatus.d = goveeStatus.ts - requestGoveeStatus.lastAt;

  if (onNextGoveeStatus)
  {
    onNextGoveeStatus(goveeStatus, oldStatus);
    onNextGoveeStatus = null;
  }
}

function formatDateTime(date, ms)
{
  if (!date)
  {
    return '';
  }

  if (!(date instanceof Date))
  {
    date = new Date(date);
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  let result = date.getFullYear();

  if (month < 10)
  {
    result += '-0' + month;
  }
  else
  {
    result += '-' + month;
  }

  if (day < 10)
  {
    result += '-0' + day;
  }
  else
  {
    result += '-' + day;
  }

  if (hours < 10)
  {
    result += ' 0' + hours;
  }
  else
  {
    result += ' ' + hours;
  }

  if (minutes < 10)
  {
    result += ':0' + minutes;
  }
  else
  {
    result += ':' + minutes;
  }

  if (seconds < 10)
  {
    result += ':0' + seconds;
  }
  else
  {
    result += ':' + seconds;
  }

  if (ms)
  {
    result += '.' + date.getMilliseconds().toString().padStart(3, '0');
  }

  return result;
}
