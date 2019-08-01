const debug = require("debug")("hubitat"),
  console = require("console"),
  WSClient = require("websocket").client,
  superagent = require("superagent"),
  HostBase = require("microservice-core/HostBase");

const POLL_TIME = 2000;

const getDevices = async () => {
  const url = `http://${
    process.env.HUBITAT_HUB
  }/apps/api/4/devices/all?access_token=${process.env.HUBITAT_TOKEN}`;
  const json = await superagent.get(url);
  return JSON.parse(json.text);
};

class Hubitat extends HostBase {
  constructor() {
    try {
      const host = process.env.MQTT_HOST || "mqtt",
        topic = process.env.MQTT_TOPIC || "hubitat";

      debug("host", host, "topic", topic);
      super(host, topic, true);
      this.token = process.env.HUBITAT_TOKEN;
      this.client.on("connect", () => {
        this.client.subscribe("hubitat/+/set/#");
        this.client.on("message", async (topic, message) => {
          message = message.toString();
          const parts = topic.split("/");
          if (parts[2] === "set") {
            await this.command(parts[1], parts[3], message);
          }
        });
      });

      // override publish() in HostBase
      this.publish = (key, value) => {
        const topic = `hubitat/${key}`;
        this.client.publish(topic, JSON.stringify(value), { retain: true });
      };
    } catch (e) {
      console.log("Error: ", e.message, e.stack);
    }
  }

  async run() {
    const devices = await getDevices();
    this.devices = {};
    for (const device of devices) {
      this.devices[device.label] = device;
    }
    debug("devices", this.devices);

    const client = new WSClient();

    client.on("connectionFailed", err => {
      console.log("Connect Error:", err.toString());
    });

    client.on("connect", connection => {
      connection.on("error", err => {
        console.log("Connection Error:", err.toString());
      });

      connection.on("close", err => {
        console.log("Connection Close:", err.toString());
      });

      connection.on("message", message => {
        try {
          const event = JSON.parse(message.utf8Data);
          debug("event", event);
          const newState = {},
            deviceName = event.displayName,
            device = this.devices[deviceName],
            isButton = ~device.type.toLowerCase().indexOf("button");

          newState[`${event.displayName}/status/${event.name}`] = isNaN(
            event.value
          )
            ? event.value
            : Number(event.value);
          this.state = newState;

          if (isButton && device.capabilities.indexOf("Release") === -1) {
            setTimeout(() => {
              newState[`${event.displayName}/status/${event.name}`] = 0;
              this.state = newState;
            }, 1000);
          }
        } catch (e) {
          //
        }
      });
    });

    client.connect("ws://hubitat/eventsocket");
    while (true) {
      const status = await getDevices();
      for (const device of status) {
        const newState = {};
        for (const attribute of Object.keys(device.attributes)) {
          if (attribute === "battery" || attribute === "temperature") {
            const value = device.attributes[attribute];
            newState[`${device.label}/status/${attribute}`] = isNaN(value)
              ? value
              : Number(value);
          }
        }
        this.state = newState;
      }
      await this.wait(POLL_TIME);
    }
  }

  async queueRunner() {
    const url = this.queue.shift();
    if (url) {
      console.log("GET ", url);
      await superagent.get(url);
    }
  }

  async waitFor(key, value) {
    console.log("waitfor ", key, value);
    const timer = setInterval(() => {
      if (this.state[key] === value) {
        console.log("waitfor state", this.state[key], value);
        clearInterval(timer);
        return;
      }
    }, 10);
  }

  async command(thing, attribute, value) {
    try {
      console.log(`command ${thing}.${attribute} = ${value}`);
      const device = this.devices[thing];
      if (!device) {
        console.log("Command: Unknown device ", thing);
        return;
      }

      let url = `http://hubitat/apps/api/4/devices/${device.id}/`;
      switch (attribute) {
        case "level":
          url += `setLevel/${value}`;
          break;
        case "switch":
          url += value;
          break;
      }
      url = `${url}?access_token=${this.token}`;
      await superagent.get(url);
      //      await this.waitFor(attribute, value);
      //      this.queue = this.queue || [];
      //      this.queue.push(url);
      //      if (!this.interval) {
      //        console.log("start");
      //        this.interval = setInterval(() => {
      //          this.queueRunner();
      //        }, 2000);
      //      }
    } catch (e) {
      console.log(e.message);
    }
  }
}

const main = async () => {
  const hub = new Hubitat();
  await hub.run();
};

main();
