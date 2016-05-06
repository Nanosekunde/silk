import assert from 'assert';
import EventEmitter from 'events';
import net from 'net';
import parseAdvertising from './advertisingDataParser';

const debug = require('debug');

const log = {
  debug: debug('silk-bledroid:debug'),
  info: debug('silk-bledroid:info'),
  warn: debug('silk-bledroid:warn'),
};

const BLE_SOCKET_PATH = '/dev/socket/bledroid';
const BLE_COMMAND_NAME = 'BleCommand';
const SOCKET_RETRY_DELAY_MS = 500;

// A single instance that talks to our bledroid socket.
let bledroid = null;

function hexStringToBuffer(hexString) {
  if (!hexString) {
    return new Buffer(0);
  }
  return new Buffer(hexString, 'hex');
}

function hexStringToUuid(hexString) {
  switch (hexString.length) {
  case 4:
  case 8:
  case 32:
    return hexString;

  default:
    log.warn(`Invalid uuid: '${hexString}'`);
    return undefined;
  }
}

class Bledroid extends EventEmitter {
  constructor() {
    log.debug('Created');

    super();

    this.socket = null;
    this.socketEventListenersInstalled = null;
    this.commandBuffer = null;

    // Do this only once at startup just to make sure the message map is sane.
    for (const mapEntry of this.messageMap) {
      assert(mapEntry.regex);

      let actionCount = 0;
      if ('emit' in mapEntry) {
        actionCount++;
      }
      if ('method' in mapEntry) {
        actionCount++;
      }
      if ('function' in mapEntry) {
        actionCount++;
      }
      assert(actionCount === 1);

      if ('transform' in mapEntry) {
        if (typeof mapEntry.transform !== 'function') {
          assert(Array.isArray(mapEntry.transform));
        }
      }
    }

    this.init();
  }

  init() {
    log.debug('Initializing');

    this.nobleConnections = new Set();
    this.adapterState = 'unknown';

    this.startBufferingCommands();

    log.info(`Connecting to '${BLE_SOCKET_PATH}' socket`);

    const socket = net.createConnection(BLE_SOCKET_PATH);

    const errorListener = (error) => {
      socket.removeListener(`error`, errorListener);
      this.onSocketConnectionError(error);
    };
    socket.on(`error`, errorListener);

    socket.once(`connect`, () => {
      socket.removeListener(`error`, errorListener);
      this.onSocketConnected(socket);
    });
  }

  startBufferingCommands() {
    if (!this.commandBuffer) {
      this.commandBuffer = { data: '' };
    }
  }

  stopBufferingCommands() {
    if (this.commandBuffer) {
      const bufferedCommandData = this.commandBuffer.data;
      this.commandBuffer = null;
      return bufferedCommandData;
    }
    return null;
  }

  onSocketConnectionError(err) {
    assert(!this.socket);
    assert(!this.socketEventListenersInstalled);

    log.warn(`Failed to connect to '${BLE_SOCKET_PATH}' socket: ${err}`);

    setTimeout(() => this.init(), SOCKET_RETRY_DELAY_MS);
  }

  onSocketConnected(socket) {
    assert(!this.socket);
    assert(!this.socketEventListenersInstalled);

    log.info(`Connected to '${BLE_SOCKET_PATH}' socket`);

    this.socket = socket;

    this.addSocketEventListener('error', this.onSocketError.bind(this));
    this.addSocketEventListener('close', this.onSocketClose.bind(this));

    let messageBuffer = { data: '' };
    this.addSocketEventListener('data',
                                this.onSocketData.bind(this, messageBuffer));

    const bufferedCommandData = this.stopBufferingCommands();

    this.command('initialize');

    if (bufferedCommandData) {
      log.debug('Sending buffered commands');
      if (!this.socket.write(bufferedCommandData)) {
        // TODO: Someday need to start buffering if the socket gets full.
        log.warn('Socket full');
      }
    }
  }

  addSocketEventListener(eventName, eventListener) {
    assert(this.socket);

    this.socketEventListenersInstalled =
      this.socketEventListenersInstalled || [ ];

    assert(this.socketEventListenersInstalled.indexOf(eventName) === -1);

    this.socket.on(eventName, eventListener);
    this.socketEventListenersInstalled.push(eventName);
  }

  onSocketError(err) {
    log.warn(`Socket 'error' event: ${err}`);

    // Buffer any further commands while we wait for the socket to close.
    this.startBufferingCommands();

    // Ending the socket should trigger a 'close' event that will reopen the
    // socket.
    this.socket.end();
  }

  onSocketClose(hadError) {
    log.info(`Socket 'close' event: ${hadError}`);

    // Remove all socket event listeners to make sure we don't get additional
    // events from the closed socket.
    this.socketEventListenersInstalled.forEach(eventName => {
      this.socket.removeAllListeners(eventName);
    });

    this.socket = null;
    this.socketEventListenersInstalled = null;

    // Buffer any further commands while we wait for bledroid to restart.
    this.startBufferingCommands();

    this.onStateChange('resetting');

    setTimeout(() => this.init(), SOCKET_RETRY_DELAY_MS);
  }

  onSocketData(messageBuffer, data) {
    data = data.toString();
    log.debug(`Socket 'data' event: '${data}'`);

    let messages = data.split('\0');

    if (messages.length === 1) {
      // No messages are complete yet. Hang on to the data for next time.
      messageBuffer.data += data;
      return;
    }

    // At least one message is complete. Join any previous data to the new data.
    messages[0] = messageBuffer.data + messages[0];

    // Update the buffer with any leftover data.
    messageBuffer.data = messages.pop();

    messages.forEach(message => this.onMessage(message));
  }

  onMessage(message) {
    function transformArg(transform, arg, index) {
      if (typeof transform === 'function') {
        return transform(arg);
      }
      transform = transform[index];
      const transformType = typeof transform;
      if (transformType === 'undefined') {
        return arg;
      }
      if (transformType === 'function') {
        return transform(arg);
      }
      return transform;
    }

    if (!message) {
      log.debug('Empty message');
      return;
    }

    // Strip off any leading message code and the newline at the end.
    let match = message.match(/^\d+\s(.+)$/);
    if (match) {
      message = match[1];
    }

    let handled = false;

    for (let map of this.messageMap) {
      match = map.regex.exec(message);
      if (!match) {
        continue;
      }

      let args = match.slice(1);

      if (map.transform) {
        args = args.map(transformArg.bind(this, map.transform));
      }

      if (map.method) {
        this[map.method].apply(this, args);
        handled = true;
      } else if (map.function) {
        map.function.apply(this, args);
        handled = true;
      } else if (map.emit) {
        this.emit.apply(this, [ map.emit ].concat(args));
        handled = true;
      } else {
        log.warn(`No 'method' or 'function' or emit' in message map: %j`, map);
      }

      break;
    }

    if (!handled) {
      log.warn(`Unhandled bledroid message: '${message}'`);
    }
  }

  command(commandStr) {
    // bledroid socket expects the command data in the following format:
    let data = `${BLE_COMMAND_NAME} "${commandStr}"\0`;
    if (data.length > 1024) {
      throw new Error(`Command is too long (${data.length})`);
    }

    if (this.commandBuffer) {
      const whitelist = /^(?:getAdapterState)/;
      if (whitelist.test(commandStr)) {
        log.debug(`Not connected, buffering command: '${commandStr}'`);
        this.commandBuffer.data += data;
      } else {
        log.warn(`Not connected, ignoring command: '${commandStr}'`);
      }
      return;
    }

    log.debug(`Sending command: '${commandStr}'`);
    if (!this.socket.write(data)) {
      // TODO: Someday need to start buffering if the socket gets full.
      log.warn('Socket full');
    }
  }

  noteNobleConnectionRequest(address) {
    if (!this.nobleConnections.has(address)) {
      this.nobleConnections.add(address);
    }
  }

  onStateChange(state) {
    if (this.adapterState !== state) {
      log.debug(`onStateChange(${state})`);
      this.adapterState = state;

      this.emit('stateChange', state);
    }
  }

  onListen(state, error) {
    if (state) {
      this.emit('advertisingStart', parseInt(error));
    } else {
      this.emit('advertisingStop');
    }
  }

  onDiscover(address, rssi, advertisingData) {
    address = address.toUpperCase();
    rssi = parseInt(rssi);
    advertisingData = parseAdvertising(hexStringToBuffer(advertisingData));

    this.emit('discover', address, rssi, advertisingData);
  }

  onServerConnect(address) {
    if (!this.nobleConnections.has(address)) {
      this.emit('serverConnect', address);
    }
  }

  onClientDisconnect(address, status, connectionId) {
    if (this.nobleConnections.has(address)) {
      this.nobleConnections.delete(address);
      this.emit('clientDisconnect', address, status, connectionId);
    }
  }

  onUnknownCommand(command) {
    log.warn(`Unknown command '${command}'`);
  }
}

/**
 * Each entry should look like this:
 *   {
 *     // Regular expression that matches the message string. Any groups that
 *     // match will be passed to the response function as arguments, in order.
 *     regex,
 *
 *     // Optional. The name of the event to emit.
 *     emit,
 *
 *     // Optional. The method (of the Bledroid object) to invoke.
 *     method,
 *
 *     // Optional. The function to invoke. Must be bound properly.
 *     function,
 *
 *     // Optional. An array of transform operations that will be run against
 *     // any arguments that are successfully matched. The array entry can be:
 *     //   <undefined>:
 *     //     No transformation is attempted and the original match is used.
 *     //   <Function>:
 *     //     The argument is passed to the function and the return value is
 *     //     substituted for the original match.
 *     //   <any>:
 *     //     The given value is substituted for the original match.
 *     transform
 *   }
 *
 * Note that exactly one of 'emit', 'method', or 'function' must be present for
 * everything to work.
 */
Bledroid.prototype.messageMap = [
  {
    regex: /^!adapterState (\w+)$/,
    method: 'onStateChange',
  }, {
    regex: /^!address ([\dA-F:]{17})$/,
    emit: 'addressChange',
  }, {
    regex: /^!rssiUpdate ([\dA-F:]{17}) (-?\d+) (\d+)$/,
    emit: 'rssiUpdate',
    transform: [ undefined, parseInt, parseInt ],
  }, {
    regex: /^!listen (0|1) (\d+)$/,
    method: 'onListen',
    transform: [ val => val === '1' ? true : false, parseInt ],
  }, {
    regex: /^!serverConnect ([\dA-F:]{17})$/,
    method: 'onServerConnect',
  }, {
    regex: /^!serverDisconnect ([\dA-F:]{17})$/,
    emit: 'serverDisconnect',
  }, {
    regex: /^!clientConnect (\d+) ([\dA-F:]{17}) (\d+) (\d+)$/,
    emit: 'clientConnect',
    transform: [ parseInt, undefined, parseInt, parseInt ],
  }, {
    regex: /^!clientDisconnect ([\dA-F:]{17}) (\d+) (\d+)$/,
    method: 'onClientDisconnect',
    transform: [ undefined, parseInt, parseInt ],
  }, {
    regex: /^!mtuChange (\d+)$/,
    emit: 'mtuChange',
    transform: [ parseInt ],
  }, {
    regex: /^!primaryServiceHandle (\d+)$/,
    emit: 'primaryServiceHandle',
    transform: [ parseInt ],
  }, {
    regex: /^!attributeHandle (-?\d+)$/,
    emit: 'attributeHandle',
    transform: [
      str => {
        let handle = parseInt(str);
        if (handle <= 0) {
          return false;
        }
        return handle;
      }
    ],
  }, {
    regex: /^!servicesSet (\d+)$/,
    emit: 'servicesSet',
    transform: [ parseInt ],
  }, {
    regex: /^!servicesDelete (\d+)$/,
    emit: 'servicesDelete',
    transform: [ parseInt ],
  }, {
    // TODO: Skipping last argument ('isLong') for now.
    regex: /^!readAttribute (\d+) (\d+) (\d+) (\d+) \d+$/,
    emit: 'readAttribute',
    transform: [ parseInt, parseInt, parseInt, parseInt, parseInt ],
  }, {
    regex: /^!writeAttribute (\d+) (\d+) (\d+) (0|1) (\d+) ([0-9a-fA-F]+)$/,
    emit: 'writeAttribute',
    transform: [
      parseInt,
      parseInt,
      parseInt,
      str => str === '1',
      parseInt,
      hexStringToBuffer
    ],
  }, {
    regex: /^!discover ([\dA-F:]{17}) (-\d+) ([\da-fA-F]+)$/,
    method: 'onDiscover',
  }, {
    regex: /^!serviceDiscover (\d+) ([\da-f]+) (\d+) (0|1)$/,
    emit: 'serviceDiscover',
    transform: [ parseInt, hexStringToUuid, parseInt, str => str === '1' ],
  }, {
    regex: /^!serviceDiscoverComplete (\d+) (\d+)$/,
    emit: 'serviceDiscoverComplete',
    transform: [ parseInt, parseInt ],
  }, {
    regex: /^!includedServiceDiscover (\d+) ([\da-f]+) ([\da-f]+) (\d+) (0|1)$/,
    emit: 'includedServiceDiscover',
    transform: [
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      parseInt,
      str => str === '1'
    ],
  }, {
    regex: /^!includedServiceDiscoverComplete (\d+) ([\da-f]+)$/,
    emit: 'includedServiceDiscoverComplete',
    transform: [ parseInt, hexStringToUuid ],
  }, {
    regex: /^!characteristicDiscover (\d+) ([\da-f]+) ([\da-f]+) (\d+) (-?\d+)$/,
    emit: 'characteristicDiscover',
    transform: [
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      parseInt,
      parseInt
    ],
  }, {
    regex: /^!characteristicDiscoverComplete (\d+) ([\da-f]+)$/,
    emit: 'characteristicDiscoverComplete',
    transform: [ parseInt, hexStringToUuid ],
  }, {
    regex: /^!descriptorDiscover (\d+) ([\da-f]+) ([\da-f]+) ([\da-f]+) (\d+)$/,
    emit: 'descriptorDiscover',
    transform: [
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      hexStringToUuid,
      parseInt
    ],
  }, {
    regex: /^!descriptorDiscoverComplete (\d+) ([\da-f]+) ([\da-f]+)$/,
    emit: 'descriptorDiscoverComplete',
    transform: [ parseInt, hexStringToUuid, hexStringToUuid ],
  }, {
    regex: /^!readCharacteristic (\d+) (\d+) ([\da-f]+) ([\da-f]+) (\d+)(?:$| ([\da-f]+)$)/,
    emit: 'readCharacteristic',
    transform: [
      parseInt,
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      parseInt,
      hexStringToBuffer
    ],
  }, {
    regex: /^!writeCharacteristic (\d+) (\d+) ([\da-f]+) ([\da-f]+)$/,
    emit: 'writeCharacteristic',
    transform: [ parseInt, parseInt, hexStringToUuid, hexStringToUuid ],
  }, {
    regex: /^!notifyEnable (\d+) (0|1) (\d+) ([\da-f]+) ([\da-f]+)$/,
    emit: 'notifyEnable',
    transform: [
      parseInt,
      str => str === '1',
      parseInt,
      hexStringToUuid,
      hexStringToUuid
    ],
  }, {
    regex: /^!notify (\d+) ([\da-f]+) ([\da-f]+) (\d+)(?:$| ([\da-f]+)$)/,
    emit: 'notify',
    transform: [
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      parseInt,
      hexStringToBuffer
    ],
  }, {
    regex: /^!readDescriptor (\d+) (\d+) ([\da-f]+) ([\da-f]+) ([\da-f]+) (\d+)(?:$| ([\da-f]+)$)/,
    emit: 'readDescriptor',
    transform: [
      parseInt,
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      hexStringToUuid,
      parseInt,
      hexStringToBuffer
    ],
  }, {
    regex: /^!writeDescriptor (\d+) (\d+) ([\da-f]+) ([\da-f]+) ([\da-f]+)$/,
    emit: 'writeDescriptor',
    transform: [
      parseInt,
      parseInt,
      hexStringToUuid,
      hexStringToUuid,
      hexStringToUuid
    ],
  }, {
    regex: /^!unknownCommand (.*)$/,
    method: 'onUnknownCommand',
  }
];

class BledroidConnection extends EventEmitter {
  constructor() {
    assert(bledroid);
    assert(bledroid instanceof Bledroid);

    super();

    // Forward events directly from our single bledroid instance to this
    // connection.
    this.on('newListener', (event, listener) => {
      bledroid.addListener(event, listener);
    });

    this.on('removeListener', (event, listener) => {
      bledroid.removeListener(event, listener);
    });

    // Add a getter for the current adapter state.
    Object.defineProperty(this, 'adapterState', {
      get: function() {
        return bledroid.adapterState;
      },
      configurable: true,
      enumerable: true
    });

    // Update our adapter state immediately.
    bledroid.command('getAdapterState');
  }
}

module.exports = function() {
  // Create our single instance if it has not yet been created.
  bledroid = bledroid || new Bledroid();

  let connection = new BledroidConnection();

  connection.command = bledroid.command.bind(bledroid);
  connection.noteNobleConnectionRequest =
    bledroid.noteNobleConnectionRequest.bind(bledroid);

  return connection;
};
