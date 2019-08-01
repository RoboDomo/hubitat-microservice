# hubitat-microservice
Microservice to control and monitor devices connected to Hubitat hub

## About

The Hubtat Elevation hub is a z-wave and zigbee home automation hub, similar to the SmartThings hub.

An advantage of Hubitat is that there is no hubitat cloud service of concern, so latency is minimal.

Another advantage is that the whole UI is served by a WWW server on the hub itself - no cloud IDE.

The Hubitat hub is almost source code (Groovy) compatible with SmartThings - porting is easy.

Hubitat Elevation is roughly the same price as the SmartThings hub.

See https://hubitat.com

## Description

This microservice is a hubitat to MQTT bridge, of sorts.  It requires the Maker API enabled in the hubitat web app.
Maker API is a built-in app, it just needs to be enabled and configured.  To configure Maker API, simply select all the
(z wave/zigbee) devices connected to the hub to enable control.  On the settings page your ```access_token``` is shown.  
You will want to set the HUBITAT_TOKEN env variable to this value.

The start-hubitat.sh script in docker-scripts repository has comments to help guide you in your env variable settings.

The microservice periodically polls the hub's Maker API for device attributes, and uses the WebSocket API to get event
messages as they occur.  Certain attributes are not present in the event stream - battery, temperature, etc., so polling
for that information is required.  

The microservice monitors MQTT "set" messages and translates those into Maker API get requests.

