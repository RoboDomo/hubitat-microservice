#!/usr/bin/env bash

# run container without making it a daemon - useful to see logging output
docker run \
    --rm \
    --name="hubitat-microservice" \
    hubitat-microservice
