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

module.exports = NodeHelper.create({
  start() {
    this.started = false;
    console.log('[PIR-Sensor] Module started');
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

  socketNotificationReceived(notification, payload) {
    if (notification === 'CONFIG' && !this.started) {
      const self = this;
      this.config = payload;
      console.log('[PIR-Sensor] Received configuration:', JSON.stringify(this.config));

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
          if (v === valueOn) {
            self.sendSocketNotification('USER_PRESENCE', true);
            if (self.config.powerSaving) {
              clearTimeout(self.deactivateMonitorTimeout);
              self.activateMonitor();
            }
          } else {
            self.sendSocketNotification('USER_PRESENCE', false);
            if (self.config.powerSaving) {
              this.deactivateMonitorTimeout = setTimeout(
                () => self.deactivateMonitor(),
                this.config.powerSavingDelay * 1000
              );
            }
          }
          this.prevSensor = v;
        }
      }, 200);

      // opcjonalny symulator ruchu
      if (this.config.runSimulator) {
        setInterval(() => {
          self.sendSocketNotification('USER_PRESENCE', true);
          setTimeout(() => self.sendSocketNotification('USER_PRESENCE', false), 1000);
        }, 20000);
      }

      this.started = true;
    }
    else if (notification === 'SCREEN_WAKEUP') {
      this.activateMonitor();
    }
  }
});

