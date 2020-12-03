process.env.DEBUG = "hubitat";
process.title = process.env.TITLE || "hubitat-microservice";

const debug = require("debug")("hubitat"),
  console = require("console"),
  WSClient = require("websocket").client,
  superagent = require("superagent"),
  HostBase = require("microservice-core/HostBase");

const express = require("express"),
  app = express(),
  port = 4000;

const HUBITAT = process.env.HUBITAT_HUB,
  TOKEN = process.env.HUBITAT_TOKEN;

const DEVICES_URL = `http://${HUBITAT}/apps/api/4/devices/all?access_token=${TOKEN}`;
const MAKER_URL = encodeURIComponent("http://nuc1:4000/maker");
const POLL_URL = `http://${HUBITAT}/apps/api/4/postURL/${MAKER_URL}?access_token=${TOKEN}`;

const getDevices = async () => {
  try {
    const json = await superagent.get(DEVICES_URL);
    return JSON.parse(json.text);
  } catch (e) {
    console.log("getDevices exception", e.message, e.stack);
  }
};

app.use(express.json());

class Hubitat extends HostBase {
  constructor() {
    const host = process.env.MQTT_HOST || "mqtt";
    const topic = process.env.MQTT_TOPIC || "hubitat";

    debug(
      "host",
      host,
      "topic",
      topic,
      "devices url",
      DEVICES_URL,
      "POLL_URL",
      POLL_URL
    );
    super(host, topic, true);

    this.devices = [];

    try {
      this.token = process.env.HUBITAT_TOKEN;

      this.client.on("connect", () => {
        // notify clients we started
        this.alert("Alert", "hubitat-microservice running");

        this.client.subscribe("hubitat/+/set/#");

        this.client.on("message", async (topic, message) => {
          message = message.toString();
          if (message === "__RESTART__") {
            this.exit(`${process.title} restarting`);
            return;
          }
          console.log("message", topic, message);
          const parts = topic.split("/");
          if (parts[2] === "set") {
            await this.command(parts[1], parts[3], message);
          }
        });
      });

      this.client.on("error", (e) => {
        // probably are in some wacky state, abort so nodemon/forever will restart us.
        this.abort("client error", e.stack);
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
      this.warn("Error: ", e.message, e.stack);
    }
  }

  async run() {
    const devices = await getDevices();
    this.devices = {};

    for (const device of devices) {
      this.devices[device.label] = device;
      debug(`device ${device.label} ${device.name}`);
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

    app.post("/maker", (req, res) => {
      const newState = {},
        event = req.body.content;

      // console.log("post event", event);
      newState[`${event.displayName}/status/${event.name}`] = isNaN(event.value)
        ? event.value
        : Number(event.value);

      this.state = newState;
      res.send({});
    });

    await superagent.get(POLL_URL);

    const client = new WSClient();

    client.on("connectionFailed", (err) => {
      console.log("Connect Error:", err.toString());
    });

    client.on("error", (e) => {
      console.log("ws client error", e);
    });
    client.on("connect", (connection) => {
      debug("ws connected!");
      connection.on("error", (err) => {
        console.log("Connection Error:", err.toString());
      });

      connection.on("close", (err) => {
        console.log("Connection Close:", err.toString());
      });

      connection.on("message", (message) => {
        try {
          const event = JSON.parse(message.utf8Data),
            newState = {};

          switch (event.source) {
            case "DEVICE":
              switch (event.name) {
                case "pollResponse":
                  break;
                case "temperature":
                  // debug(
                  //   new Date().toLocaleTimeString(),
                  //   "WS event temperature",
                  //   event.displayName,
                  //   event.value
                  // );
                  break;
                case "battery":
                  debug(
                    new Date().toLocaleTimeString(),
                    "WS event battery",
                    event.displayName,
                    event.value
                  );
                  break;
                default:
                  // debug(new Date().toLocaleTimeString(), "WS event", event);
                  break;
              }
              break;
            case "LOCATION":
              debug(
                new Date().toLocaleTimeString(),
                "WS event location",
                event.displayName,
                event.name,
                event.value
              );
              break;
            default:
              debug(new Date().toLocaleTimeString(), "WS event", event);
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

    client.connect("ws://hubitat/eventsocket");
    app.listen(port, () => {
      console.log(`hubitat-microservice listening on port ${port}`);
    });
  }

  async command(thing, attribute, value) {
    console.log("thing", thing, "attribute", attribute, "value", value);
    if (thing === "reset") {
      this.abort("hubitat-microservice RESET");
      return;
    }
    let uri;
    try {
      const device = this.devices[thing];
      if (!device) {
        debug(`Command: Unknown device '${thing}', ${attribute}, ${value}`);
        return;
      }
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
        case "lock":
        case "locked":
          device.locked = true;
          url += `lock`;
          break;
        case "unlock":
        case "unlocked":
          device.locked = false;
          url += `unlock`;
          break;
        case "hue":
          url += `setHue/${value}`;
          break;
        case "saturation":
          url += `setSaturation/${value}`;
          break;
        case "white":
          break;
        case "whiteLevel":
          break;
        case "warm":
          break;
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
              b: value.b,
            };
          } else {
            device.color = {
              r: parseInt(value.substr(0, 2), 16),
              g: parseInt(value.substr(2, 2), 16),
              b: parseInt(value.substr(4, 2), 16),
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
      debug(`command ${thing}.${attribute} = ${value}`, url);
      await superagent.get(url);
      if (
        ~device.capabilities.indexOf("ColorControl") &&
        attribute === "switch" &&
        value === "on"
      ) {
        await this.command(thing, "color", device.color);
        await this.command(thing, "level", device.level);
      }
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
