#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup-droplet.sh — provision a fresh Ubuntu 22.04/24.04 DigitalOcean droplet
# to run the Game Plan nightly scraper as a permanent service.
#
#   ssh root@YOUR_DROPLET_IP
#   bash setup-droplet.sh
#
# Installs: Node 20, Google Chrome, Xvfb (REQUIRED — the launcher enables Xvfb
# on Linux), a dedicated 'gameplan' user, swap, and the systemd unit.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/game-plan-auto-browser
APP_USER=gameplan
LOG_DIR=/var/log/gameplan

echo "==> Updating packages"
apt-get update -y
apt-get upgrade -y

echo "==> Base tools"
apt-get install -y curl wget gnupg ca-certificates unzip git

echo "==> Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Google Chrome (puppeteer-real-browser drives the real browser)"
if ! command -v google-chrome >/dev/null 2>&1; then
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi
google-chrome --version

echo "==> Xvfb + fonts (REQUIRED: the launcher sets disableXvfb=false on Linux)"
# Without Xvfb, Chrome cannot start on a headless droplet and every run fails.
apt-get install -y xvfb x11-utils \
  fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libu2f-udev 2>/dev/null || \
apt-get install -y xvfb x11-utils \
  fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libu2f-udev

echo "==> Swap (Chrome spikes; swap prevents the OOM killer eating a run)"
if ! swapon --show | grep -q swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
free -h

echo "==> Service user + directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$APP_USER -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"

echo ""
echo "=============================================================="
echo "Base system ready. Now:"
echo ""
echo "  1. Upload the project to $APP_DIR"
echo "       scp -r game-plan-auto-browser/* root@THIS_IP:$APP_DIR/"
echo ""
echo "  2. Install deps and set config:"
echo "       cd $APP_DIR && npm install --omit=dev"
echo "       cp .env.example .env && nano .env      # MONGO_URI, JWT_SECRET, …"
echo "       nano proxies.txt                        # your proxy IPs"
echo "       chown -R $APP_USER:$APP_USER $APP_DIR"
echo ""
echo "  3. Test ONE store before enabling the timer:"
echo "       sudo -u $APP_USER node daily.js --scrape-now --concurrency 1"
echo ""
echo "  4. Install the service:"
echo "       cp deploy/gameplan-scraper.service /etc/systemd/system/"
echo "       systemctl daemon-reload"
echo "       systemctl enable --now gameplan-scraper"
echo "       journalctl -u gameplan-scraper -f"
echo "=============================================================="
