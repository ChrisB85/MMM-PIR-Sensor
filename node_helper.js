'use strict';

/* Magic Mirror
 * Module: MMM-PIR-Sensor (node-libgpiod + xrandr only)
 *
 * By Paul-Vincent Roll http://paulvincentroll.com
 * MIT Licensed.
 */

const NodeHelper = require('node_helper');
const { Chip, Line } = require('node-libgpiod');
const exec = require('child_process').exec;
const mqtt = require('mqtt');

module.exports = NodeHelper.create({
  start() {
    this.started = false;
    this.mqttClient = null;
    this.motionTimeout = null;
    this.motionRefreshInterval = null;
    this.motionDetected = false;
    console.log('[PIR-Sensor] Module started');
  },

  stop() {
    if (this.mqttClient) {
      this.mqttClient.end();
      this.mqttClient = null;
    }
    if (this.motionTimeout) {
      clearTimeout(this.motionTimeout);
      this.motionTimeout = null;
    }
    if (this.motionRefreshInterval) {
      clearInterval(this.motionRefreshInterval);
      this.motionRefreshInterval = null;
    }
  },

  activateMonitor() {
    console.log('[PIR-Sensor] Attempting to activate monitor');
    // always-off override
    if (this.alwaysOffLine && this.alwaysOffLine.getValue() === this.config.alwaysOffState) {
      console.log('[PIR-Sensor] Monitor activation blocked by always-off trigger');
      return;
    }

    if (this.relayLine) {
      this.relayLine.setValue(this.config.relayState);
    } else {
      exec("xrandr --display :0 --output HDMI-1 --auto");
    }

    clearInterval(this.briefHDMIWakeupInterval);
    clearTimeout(this.briefHDMIWakeupPhase2Timeout);
    this.briefHDMIWakeupInterval = null;
  },

  deactivateMonitor() {
    // always-on override
    if (
      this.alwaysOnLine &&
      this.alwaysOnLine.getValue() === this.config.alwaysOnState &&
      !(this.alwaysOffLine && this.alwaysOffLine.getValue() === this.config.alwaysOffState)
    ) {
      return;
    }

    if (this.relayLine) {
      this.relayLine.setValue((this.config.relayState + 1) % 2);
    } else {
      exec("xrandr --display :0 --output HDMI-1 --off");
    }

    if (this.config.preventHDMITimeout > 0 && this.config.preventHDMITimeout < 10) {
      this.briefHDMIWakeupInterval = setInterval(() => {
        this.briefHDMIWakeup();
      }, this.config.preventHDMITimeout * 60 * 1000);
    }
  },

  briefHDMIWakeup() {
    // zamiast vcgencmd: raz włączamy, po chwili wyłączamy
    exec("xrandr --display :0 --output HDMI-1 --auto");
    this.briefHDMIWakeupPhase2Timeout = setTimeout(() => {
      exec("xrandr --display :0 --output HDMI-1 --off");
    }, 1000);
  },

  setMotionState(self, detected) {
    if (detected === this.motionDetected) {
      return; // Stan się nie zmienił
    }

    this.motionDetected = detected;
    console.log('[PIR-Sensor] Setting motion state to:', detected ? 'ON' : 'OFF');

    if (detected) {
      // Motion detected
      self.sendSocketNotification('USER_PRESENCE', true);
      if (self.config.powerSaving) {
        clearTimeout(self.deactivateMonitorTimeout);
        self.activateMonitor();
      }
      // Publish to MQTT
      if (self.mqttClient && self.mqttStateTopic) {
        self.mqttClient.publish(self.mqttStateTopic, 'ON');
      }

      // Start refresh interval to maintain motion state
      if (this.motionRefreshInterval) {
        clearInterval(this.motionRefreshInterval);
      }
      this.motionRefreshInterval = setInterval(() => {
        if (this.motionDetected) {
          console.log('[PIR-Sensor] Refreshing motion state');
          if (self.mqttClient && self.mqttStateTopic) {
            self.mqttClient.publish(self.mqttStateTopic, 'ON');
          }
        }
      }, 1000); // Refresh every second
    } else {
      // No motion
      self.sendSocketNotification('USER_PRESENCE', false);
      if (self.config.powerSaving) {
        this.deactivateMonitorTimeout = setTimeout(
          () => self.deactivateMonitor(),
          this.config.powerSavingDelay * 1000
        );
      }
      // Publish to MQTT
      if (self.mqttClient && self.mqttStateTopic) {
        self.mqttClient.publish(self.mqttStateTopic, 'OFF');
      }

      // Stop refresh interval
      if (this.motionRefreshInterval) {
        clearInterval(this.motionRefreshInterval);
        this.motionRefreshInterval = null;
      }
    }
  },

  handleMotionDetected(self, detected) {
    if (detected) {
      // Motion detected - set state to ON and start/refresh timer
      this.setMotionState(self, true);
      
      // Clear any existing timeout
      if (this.motionTimeout) {
        clearTimeout(this.motionTimeout);
      }
      
      // Set new timeout to turn off motion after 10 seconds of no detection
      this.motionTimeout = setTimeout(() => {
        this.setMotionState(self, false);
      }, 10000);
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === 'CONFIG' && !this.started) {
      const self = this;
      this.config = payload;
      console.log('[PIR-Sensor] Received configuration:', JSON.stringify(this.config));

      // Initialize MQTT if configured
      if (this.config.mqtt) {
        try {
          const mqttConfig = this.config.mqtt;
          const mqttUrl = `mqtt://${mqttConfig.host}:${mqttConfig.port || 1883}`;
          this.mqttClient = mqtt.connect(mqttUrl, {
            username: mqttConfig.username,
            password: mqttConfig.password,
            clientId: `magicmirror-pir-${Math.random().toString(16).slice(3)}`
          });

          this.mqttClient.on('connect', () => {
            console.log('[PIR-Sensor] Connected to MQTT broker');
            // Publish Home Assistant discovery config
            const topicPrefix = mqttConfig.topic_prefix || 'magicmirror';
            const discoveryTopic = `homeassistant/binary_sensor/${topicPrefix}_pir/config`;
            const stateTopic = `${topicPrefix}/pir/state`;
            const discoveryPayload = {
              name: 'MagicMirror PIR Sensor',
              state_topic: stateTopic,
              device_class: 'motion',
              unique_id: `${topicPrefix}_pir_sensor`,
              device: {
                name: 'MagicMirror',
                model: 'PIR Motion Sensor',
                manufacturer: 'MagicMirror',
                identifiers: [`${topicPrefix}_pir`]
              },
              availability_topic: `${topicPrefix}/pir/availability`,
              payload_available: 'online',
              payload_not_available: 'offline',
              state_on: 'ON',
              state_off: 'OFF'
            };
            this.mqttClient.publish(discoveryTopic, JSON.stringify(discoveryPayload), { retain: true });
            this.mqttClient.publish(`${topicPrefix}/pir/availability`, 'online', { retain: true });
            this.mqttStateTopic = stateTopic;
          });

          this.mqttClient.on('error', (error) => {
            console.error('[PIR-Sensor] MQTT error:', error);
          });

          this.mqttClient.on('close', () => {
            if (this.mqttClient) {
              const topicPrefix = mqttConfig.topic_prefix || 'magicmirror';
              this.mqttClient.publish(`${topicPrefix}/pir/availability`, 'offline', { retain: true });
            }
          });
        } catch (error) {
          console.error('[PIR-Sensor] Failed to initialize MQTT:', error);
        }
      }

      // inicjalizacja libgpiod
      this.chip = new Chip(0);

      // relayPin jako output
      if (this.config.relayPin !== false) {
        this.relayLine = new Line(this.chip, this.config.relayPin);
        this.relayLine.requestOutputMode();
        this.relayLine.setValue(this.config.relayState);
      }

      // alwaysOnPin jako input (polling)
      if (this.config.alwaysOnPin) {
        this.alwaysOnLine = new Line(this.chip, this.config.alwaysOnPin);
        this.alwaysOnLine.requestInputMode();
        this.prevAlwaysOn = this.alwaysOnLine.getValue();
        setInterval(() => {
          const v = this.alwaysOnLine.getValue();
          if (v !== this.prevAlwaysOn) {
            const on = v === this.config.alwaysOnState;
            self.sendSocketNotification('ALWAYS_ON', on);
            self.sendSocketNotification('SHOW_ALERT', {
              title: on ? 'Always-On Activated' : 'Always-On Deactivated',
              message: on
                ? 'Mirror will not activate power-saving mode'
                : 'Mirror will now use motion sensor to activate',
              timer: 4000
            });
            if (self.config.powerSaving && on) clearTimeout(self.deactivateMonitorTimeout);
            this.prevAlwaysOn = v;
          }
        }, 200);
      }

      // alwaysOffPin jako input (polling)
      if (this.config.alwaysOffPin) {
        this.alwaysOffLine = new Line(this.chip, this.config.alwaysOffPin);
        this.alwaysOffLine.requestInputMode();
        this.prevAlwaysOff = this.alwaysOffLine.getValue();
        setInterval(() => {
          const v = this.alwaysOffLine.getValue();
          if (v !== this.prevAlwaysOff) {
            const off = v === this.config.alwaysOffState;
            self.sendSocketNotification('ALWAYS_OFF', off);
            if (off) {
              self.deactivateMonitor();
            } else {
              self.activateMonitor();
              if (self.config.powerSaving) clearTimeout(self.deactivateMonitorTimeout);
            }
            this.prevAlwaysOff = v;
          }
        }, 200);
      } else {
        // brak alwaysOffPin – wymuś włączenie przy starcie
        this.activateMonitor();
      }

      // powerSaving: wstępny timeout na wyłączenie
      if (this.config.powerSaving) {
        this.deactivateMonitorTimeout = setTimeout(
          () => this.deactivateMonitor(),
          this.config.powerSavingDelay * 1000
        );
      }

      // PIR sensor jako input (polling)
      try {
        console.log('[PIR-Sensor] Initializing PIR sensor on GPIO pin:', this.config.sensorPin);
        this.sensorLine = new Line(this.chip, this.config.sensorPin);
        this.sensorLine.requestInputMode();
        console.log('[PIR-Sensor] PIR sensor initialized successfully');
      } catch (error) {
        console.error('[PIR-Sensor] Failed to initialize PIR sensor:', error.message);
        return;
      }

      this.prevSensor = this.sensorLine.getValue();
      const valueOn = this.config.sensorState;
      setInterval(() => {
        const v = this.sensorLine.getValue();
        if (v !== this.prevSensor) {
          console.log('[PIR-Sensor] Sensor state changed:', v === valueOn ? 'MOVEMENT DETECTED' : 'NO MOVEMENT');
          this.handleMotionDetected(self, v === valueOn);
          this.prevSensor = v;
        }
      }, 200);

      // opcjonalny symulator ruchu
      if (this.config.runSimulator) {
        setInterval(() => {
          this.handleMotionDetected(self, true);
          setTimeout(() => this.handleMotionDetected(self, false), 1000);
        }, 20000);
      }

      this.started = true;
    }
    else if (notification === 'SCREEN_WAKEUP') {
      this.activateMonitor();
    }
  }
});

