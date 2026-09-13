FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:/opt/gradle/bin

RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    git \
    ca-certificates \
    graphicsmagick \
    ghostscript \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Android SDK
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    cd /tmp && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip && \
    unzip -q cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm cmdline-tools.zip

RUN yes | sdkmanager --licenses > /dev/null || true && \
    sdkmanager \
    "platform-tools" \
    "platforms;android-35" \
    "build-tools;35.0.0"

# Gradle
RUN cd /tmp && \
    wget -q https://services.gradle.org/distributions/gradle-8.9-bin.zip -O gradle.zip && \
    unzip -q gradle.zip -d /opt && \
    ln -s /opt/gradle-8.9 /opt/gradle && \
    rm gradle.zip

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN npx playwright install --with-deps chromium

EXPOSE 10000

CMD ["npm", "start"]
