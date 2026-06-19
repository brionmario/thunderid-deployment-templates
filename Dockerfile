# ----------------------------------------------------------------------------
# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
# ----------------------------------------------------------------------------

FROM alpine:3.19

RUN apk add --no-cache sqlite openssl ca-certificates bash curl unzip lsof

# Download the ThunderID release.
# Pass --build-arg THUNDER_VERSION=x.y.z to pin a version; omit to pull latest automatically.
ARG THUNDER_VERSION

RUN set -eux; \
    if [ -z "$THUNDER_VERSION" ]; then \
        THUNDER_VERSION=$(curl -sf https://brionmario.github.io/thunderid/data/releases.json \
            | grep -o '"tagName":"v[^"]*"' | head -1 | sed 's/.*"v//;s/"//'); \
    fi; \
    ASSET="thunderid-${THUNDER_VERSION}-linux-x64.zip"; \
    curl -fsSL -o /tmp/thunder.zip \
        "https://github.com/thunder-id/thunderid/releases/download/v${THUNDER_VERSION}/${ASSET}"; \
    mkdir -p /app; \
    cd /tmp && unzip thunder.zip; \
    cp -r thunderid-*/* /app/; \
    rm -rf /tmp/thunder.zip /tmp/thunderid-*

WORKDIR /app

# Replace the bundled deployment.yaml with a cloud-ready template.
# Placeholders are substituted at runtime by entrypoint.sh using Vercel env vars.
COPY .thunderdeploy/deployment.yaml deployment.yaml

COPY .thunderdeploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN addgroup -S thunderid && adduser -S thunderid -G thunderid \
    && chown -R thunderid:thunderid /app

USER thunderid

EXPOSE 8090

ENTRYPOINT ["/entrypoint.sh"]
