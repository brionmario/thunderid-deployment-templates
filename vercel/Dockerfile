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

FROM ghcr.io/thunder-id/thunderid:latest

USER root

# Replace the bundled deployment.yaml with a cloud-ready template.
# Placeholders are substituted at runtime by entrypoint.sh using Vercel env vars.
COPY .thunderdeploy/deployment.yaml /opt/thunderid/deployment.yaml

COPY .thunderdeploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && chown thunderid:thunderid /opt/thunderid/deployment.yaml

USER thunderid

ENTRYPOINT ["/entrypoint.sh"]
