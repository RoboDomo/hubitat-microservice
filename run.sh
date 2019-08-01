#!/usr/bin/env bash

docker run \
    -d \
    --rm \
    -e MQTT_HOST="mqtt://nuc1" \
    -e HUBITAT_TOKEN=$HUBITAT_TOKEN \
    -e HUBITAT_HUB=$HUBITAT_HUB \
    -e DEBUG="HostBase,hubitat" \
    --name="hubitat-microservice" \
    hubitat-microservice
