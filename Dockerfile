# Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
# SPDX-License-Identifier: MIT

#FROM fossology/fossology:3.4.0 as fossology
#COPY fossology_init.sh fossology_init.sh
#RUN ./fossology_init.sh

FROM node:18-bullseye
ENV APPDIR=/opt/service
#RUN apk update && apk upgrade && \
#    apk add --no-cache bash git openssh

ARG BUILD_NUMBER=0
ENV CRAWLER_BUILD_NUMBER=$BUILD_NUMBER

# Ruby and Python Dependencies
RUN apt-get update && apt-get install -y --no-install-recommends --no-install-suggests curl bzip2 build-essential libssl-dev libreadline-dev zlib1g-dev cmake python3 python3-dev python3-pip xz-utils libxml2-dev libxslt1-dev libpopt0 && \
  rm -rf /var/lib/apt/lists/* && \
  curl -L https://github.com/rbenv/ruby-build/archive/refs/tags/v20231012.tar.gz | tar -zxvf - -C /tmp/ && \
  cd /tmp/ruby-build-* && ./install.sh && cd / && \
  ruby-build -v 3.2.2 /usr/local && rm -rfv /tmp/ruby-build-* && \
  gem install bundler -v 2.5.4 --no-document

# Scancode
ARG SCANCODE_VERSION="30.1.0"
RUN pip3 install --upgrade pip setuptools wheel && \
  curl -Os https://raw.githubusercontent.com/nexB/scancode-toolkit/v$SCANCODE_VERSION/requirements.txt && \
  pip3 install --constraint requirements.txt scancode-toolkit==$SCANCODE_VERSION && \
  rm requirements.txt && \
  scancode --reindex-licenses && \
  scancode --version

ENV SCANCODE_HOME=/usr/local/bin

# Licensee
# Licensee and its dependencies pinned to its latest version which helped to update the ruby to its recent version,
# Component npm/npmjs/-/caniuse-lite/1.0.30001344 is getting identified by its correct license but the matcher is dice.
# The match is not an exact match and hence not adopted by CD licensee summarizer.
RUN gem install nokogiri:1.16.0 --no-document && \
  gem install faraday:2.9.0 --no-document && \
  gem install public_suffix:5.0.4 --no-document && \
  gem install licensee:9.16.1 --no-document

# REUSE
RUN pip3 install setuptools
RUN pip3 install reuse==3.0.1

# FOSSology
# WORKDIR /opt
# RUN git clone https://github.com/fossology/fossology.git
# RUN cd fossology && git checkout -b clearlydefined tags/3.4.0

# See https://github.com/fossology/fossology/blob/faaaeedb9d08f00def00f9b8a68a5cffc5eaa657/utils/fo-installdeps#L103-L105
# Additional libjsoncpp-dev https://github.com/fossology/fossology/blob/261d1a3e663b5fd20652a05b2d6360f4b31a17cb/src/copyright/mod_deps#L79-L80
# RUN apt-get update && apt-get install -y --no-install-recommends --no-install-suggests \
#  libmxml-dev curl libxml2-dev libcunit1-dev libjsoncpp-dev \
#  build-essential libtext-template-perl subversion rpm librpm-dev libmagic-dev libglib2.0 libboost-regex-dev libboost-program-options-dev

# WORKDIR /opt/fossology/src/nomos/agent
# RUN make -f Makefile.sa
# RUN echo $(./nomossa -V)

# NOTE: must build copyright before Monk to cause libfossology to be built
# WORKDIR /opt/fossology/src/copyright/agent
# RUN make

# WORKDIR /opt/fossology/src/monk/agent
# RUN make
# RUN echo $(./monk -V)
# COPY --from=fossology /tmp/monk_knowledgebase .

# ENV FOSSOLOGY_HOME=/opt/fossology/src

# Crawler config
ENV CRAWLER_DEADLETTER_PROVIDER=cd(azblob)
ENV CRAWLER_NAME=cdcrawlerprod
ENV CRAWLER_QUEUE_PREFIX=cdcrawlerprod
ENV CRAWLER_QUEUE_PROVIDER=storageQueue
ENV CRAWLER_STORE_PROVIDER=cdDispatch+cd(azblob)+azqueue
ENV CRAWLER_WEBHOOK_URL=https://api.clearlydefined.io/webhook
ENV CRAWLER_AZBLOB_CONTAINER_NAME=production

RUN git config --global --add safe.directory '*'

COPY package*.json /tmp/
COPY patches /tmp/patches
RUN cd /tmp && npm install --production
RUN mkdir -p "${APPDIR}" && cp -a /tmp/node_modules "${APPDIR}"

WORKDIR "${APPDIR}"
COPY . "${APPDIR}"

ENV PORT 5000
EXPOSE 5000
ENTRYPOINT ["node", "index.js"]
