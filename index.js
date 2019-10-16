const debug = require("debug")("hubitat"),
  console = require("console"),
  WSClient = require("websocket").client,
  superagent = require("superagent"),
  HostBase = require("microservice-core/HostBase");

const POLL_TIME = 2000;

const DEVICES_URL = `http://${
  process.env.HUBITAT_HUB
}/apps/api/4/devices/all?access_token=${process.env.HUBITAT_TOKEN}`;

const getDevices = async () => {
  try {
    const json = await superagent.get(DEVICES_URL);
    return JSON.parse(json.text);
  } catch (e) {
    console.log("getDevices exception", e.message, e.stack);
  }
};

class Hubitat extends HostBase {
  constructor() {
    const host = process.env.MQTT_HOST || "mqtt",
      topic = process.env.MQTT_TOPIC || "hubitat";

    debug("host", host, "topic", topic, "url", DEVICES_URL);
    super(host, topic, true);
    this.devices = [];

    try {
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

      this.client.on("error", e => {
        console.log("client error", e);
      });

      // override publish() in HostBase
      this.publish = (key, value) => {
        const topic = `hubitat/${key}`;
        debug(
          new Date().toLocaleTimeString(),
          "publish",
          topic,
          JSON.stringify(value)
        );
        this.client.publish(topic, JSON.stringify(value), { retain: true });
      };
    } catch (e) {
      console.log("Error: ", e.message, e.stack);
    }
  }

  async run() {
    const devices = await getDevices();
    //    console.log("GOT ", devices);
    this.devices = {};
    for (const device of devices) {
      this.devices[device.label] = device;
      debug("device", device.label, device, device.commands);
      try {
        if (~device.capabilities.indexOf("SwitchLevel")) {
          device.level = 100;
        }
        if (~device.capabilities.indexOf("ColorControl")) {
          device.color = { r: 255, g: 0, b: 255 };
        }
      } catch (e) {
        debug("Exception ", e.message, device);
      }
    }
    //    debug("devices", this.devices);
    //    console.log(
    //      this.devices["Cabinet Controller"],
    //      this.devices["Cabinet Controller"].commands
    //    );

    const client = new WSClient();

    client.on("connectionFailed", err => {
      console.log("Connect Error:", err.toString());
    });

    client.on("error", e => {
      console.log("ws client error", e);
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
          const event = JSON.parse(message.utf8Data),
            newState = {};

          switch (event.source) {
            case "DEVICE":
              switch (event.name) {
                case "temperature":
                  debug(
                    new Date().toLocaleTimeString(),
                    "event temperature",
                    event.displayName,
                    event.value
                  );
                  break;
                case "battery":
                  debug(
                    new Date().toLocaleTimeString(),
                    "event battery",
                    event.displayName,
                    event.value
                  );
                  break;
                default:
                  debug(new Date().toLocaleTimeString(), "event", event);
                  break;
              }
              break;
            case "LOCATION":
              debug(
                new Date().toLocaleTimeString(),
                "event location",
                event.displayName,
                event.name,
                event.value
              );
              break;
            default:
              debug(new Date().toLocaleTimeString(), "event", event);
              break;
          }

          newState[`${event.displayName}/status/${event.name}`] = isNaN(
            event.value
          )
            ? event.value
            : Number(event.value);

          this.state = newState;

          if (event.source === "DEVICE") {
            const deviceName = event.displayName,
              device = this.devices[deviceName],
              isButton = ~device.type.toLowerCase().indexOf("button");

            if (
              isButton &&
              event.name !== "temperature" &&
              event.name !== "battery" &&
              device.capabilities.indexOf("Release") === -1
            ) {
              setTimeout(() => {
                newState[`${event.displayName}/status/${event.name}`] = 0;
                this.state = newState;
              }, 1000);
            }
          }
        } catch (e) {
          //
          console.log(new Date().toLocateTimeString(), "exception", e.message);
        }
      });
    });

    // POLL
    client.connect("ws://hubitat/eventsocket");
    while (true) {
      const status = await getDevices();
      for (const device of status) {
        const newState = {};
        for (const attribute of Object.keys(device.attributes)) {
          if (attribute === "dataType" || attribute === "values") {
            continue;
          }
          const key = `${device.label}/status/${attribute}`,
            value = device.attributes[attribute];

          if (
            attribute === "battery" ||
            attribute === "temperature" ||
            attribute === "presence"
          ) {
            newState[key] = isNaN(value) ? value : Number(value);
            //            if (attribute === "presence") {
            //              debug(
            //                new Date().toLocaleTimeString(),
            //                device.label,
            //                device.attributes.presence
            //              );
            //            }
            if (!this.state || newState[key] !== this.state[key]) {
              debug(
                new Date().toLocaleTimeString(),
                device.label,
                attribute,
                value
              );
            }
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
      try {
        console.log("GET ", url);
        await superagent.get(url);
      } catch (e) {
        //
        this.queue.unshift(url);
      }
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
    let uri;
    try {
      const device = this.devices[thing];
      if (!device) {
        console.log("Command: Unknown device ", thing);
        return;
      }
      console.log(`command RAW ${thing}.${attribute} = `, value, device);

      try {
        const v = Math.round(value);
        if (!Number.isNaN(v)) {
          value = v;
        }
      } catch (e) {
        //
      }
      let url = `http://hubitat/apps/api/4/devices/${device.id}/`;
      switch (attribute) {
        case "level":
          device.level = value;
          url += `setLevel/${value}`;
          break;
        case "hue":
          url += `setHue/${value}`;
          break;
        case "saturation":
          url += `setSaturation/${value}`;
          break;
        case "white":
        case "whiteLevel":
        case "warm":
        case "warmLevel":
          url += `setWarmWhiteLevel/${value}`;
          break;
        case "color":
          url += `setColor/${value}`;
          console.log("color", value);
          if (value.r !== undefined) {
            device.color = {
              r: value.r,
              g: value.g,
              b: value.b
            };
          } else {
            device.color = {
              r: parseInt(value.substr(0, 2), 16),
              g: parseInt(value.substr(2, 2), 16),
              b: parseInt(value.substr(4, 2), 16)
            };
          }
          break;
        case "effect":
          url += `setEffect/${value}`;
          break;
        case "switch":
          url += value;
          break;
        case "red":
          device.color.r = value;
          url += `setRedLevel/${value}`;
          break;
        case "green":
          device.color.g = value;
          url += `setGreenLevel/${value}`;
          break;
        case "blue":
          device.color.b = value;
          url += `setBlueLevel/${value}`;
          break;
      }
      url = `${url}?access_token=${this.token}`;
      uri = url;
      console.log(`command ${thing}.${attribute} = ${value}`, url);
      await superagent.get(url);
      if (
        ~device.capabilities.indexOf("ColorControl") &&
        attribute === "switch" &&
        value === "on"
      ) {
        await this.command(thing, "color", device.color);
        await this.command(thing, "level", device.level);
      }
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
      console.log("GET error", uri, e.message, e.stack);
    }
  }
}

const main = async () => {
  const hub = new Hubitat();
  await hub.run();
};

main();
