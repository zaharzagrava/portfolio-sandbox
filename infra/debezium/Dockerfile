# Debezium Connect with the scripting plugin (Groovy) that the `kind = 'event'` filter of outbox-connector.json needs.
# Build: docker build -t marketplace/debezium-connect:3.0 infra/debezium
FROM quay.io/debezium/connect:3.0

ARG DEBEZIUM_VERSION=3.0.0.Final

USER root
RUN cd /tmp \
 && curl -fsSLO "https://repo1.maven.org/maven2/io/debezium/debezium-scripting/${DEBEZIUM_VERSION}/debezium-scripting-${DEBEZIUM_VERSION}.tar.gz" \
 && tar -xzf "debezium-scripting-${DEBEZIUM_VERSION}.tar.gz" -C /kafka/connect/debezium-connector-postgres --strip-components=1 \
 && rm "debezium-scripting-${DEBEZIUM_VERSION}.tar.gz"
USER kafka
