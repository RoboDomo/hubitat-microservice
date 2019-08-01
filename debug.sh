#!/usr/bin/env bash

# run container without making it a daemon - useful to see logging output
docker run \
    --rm \
    --name="hubitat-microservice" \
    -e MQTT_HOST="mqtt://nuc1" \
    -e HUBITAT_TOKEN=$HUBITAT_TOKEN \
    -e HUBITAT_HUB=$HUBITAT_HUB \
    -e DEBUG="HostBase,hubitat" \
    robodomo/hubitat-microservice
