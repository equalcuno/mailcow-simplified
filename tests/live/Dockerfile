ARG DIND_BASE=docker:28-dind
FROM ${DIND_BASE}
RUN apk add --no-cache bash git openssl curl jq rsync coreutils grep sed gawk findutils iproute2 iptables python3
COPY manage.sh /harness/manage.sh
RUN chmod +x /harness/manage.sh
# The official DinD entrypoint starts an isolated daemon. No host Docker socket.
