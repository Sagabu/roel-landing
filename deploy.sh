#!/bin/bash
# Fuglehundprove deployment script for Hetzner CX23
# Run as root on fresh Ubuntu 22.04/24.04

set -e

DOMAIN="${1:-fuglehundprove.no}"
REPO_URL="https://github.com/YOUR_ORG/roel-landing.git"  # Update with actual repo

echo "=== Fuglehundprove Server Setup ==="
echo "Domain: $DOMAIN"
echo ""

# 1. System updates
echo ">>> Updating system..."
apt update && apt upgrade -y

# 2. Install Node.js 22
echo ">>> Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 3. Install PM2
echo ">>> Installing PM2..."
npm install -g pm2

# 4. Install Caddy
echo ">>> Installing Caddy..."
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy -y

# 5. Create app directory
echo ">>> Setting up app directory..."
mkdir -p /var/www/fuglehund
mkdir -p /var/log/fuglehund
mkdir -p /var/log/caddy

# 6. Clone repo (or copy files)
echo ">>> Deploying application..."
if [ -d ".git" ]; then
    echo "    Copying from local directory..."
    cp -r ./*.js ./*.html ./*.json /var/www/fuglehund/
    cp -r ./package*.json /var/www/fuglehund/
else
    echo "    Cloning from repo..."
    git clone "$REPO_URL" /var/www/fuglehund
fi

# 7. Install dependencies
echo ">>> Installing npm dependencies..."
cd /var/www/fuglehund
npm install --production

# 8. Create .env file (Sveve creds needed)
echo ">>> Creating .env..."
if [ ! -f .env ]; then
    cat > .env << 'EOF'
PORT=8889
SVEVE_USER=
SVEVE_PASS=
EOF
    echo "    IMPORTANT: Edit /var/www/fuglehund/.env with Sveve credentials!"
fi

# 9. Configure Caddy
echo ">>> Configuring Caddy..."
cat > /etc/caddy/Caddyfile << EOF
$DOMAIN {
    reverse_proxy localhost:8889

    encode gzip zstd

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }

    log {
        output file /var/log/caddy/fuglehund.log
        format json
    }
}
EOF

# 10. Start services
echo ">>> Starting services..."
cd /var/www/fuglehund
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root

systemctl restart caddy
systemctl enable caddy

# 11. Firewall
echo ">>> Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "1. Point DNS A record for $DOMAIN -> $(curl -s ifconfig.me)"
echo "2. Edit /var/www/fuglehund/.env with Sveve credentials"
echo "3. Restart app: pm2 restart fuglehund"
echo "4. Test: https://$DOMAIN"
echo ""
echo "Useful commands:"
echo "  pm2 logs fuglehund    # View logs"
echo "  pm2 restart fuglehund # Restart app"
echo "  caddy reload          # Reload Caddy config"
echo "  cat /var/log/caddy/fuglehund.log | tail -50  # Caddy logs"
