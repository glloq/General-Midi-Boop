#!/bin/bash
# scripts/generate-cert.sh
# Generate a self-signed SSL certificate for HTTPS on Raspberry Pi
set -e

CERT_DIR="./data/ssl"
CERT_FILE="$CERT_DIR/server.crt"
KEY_FILE="$CERT_DIR/server.key"
ENV_FILE=".env"
DAYS=365

echo "=== Maestro SSL Certificate Generator ==="

# Check for openssl
if ! command -v openssl &>/dev/null; then
  echo "Error: openssl is required. Install with: sudo apt install openssl"
  exit 1
fi

# Create directory
mkdir -p "$CERT_DIR"

# Check if certs already exist
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  echo "Certificate already exists at $CERT_FILE"
  read -p "Overwrite? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Get hostname for the cert
HOSTNAME=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$HOSTNAME" ]; then
  HOSTNAME="localhost"
fi

echo "Generating self-signed certificate for: $HOSTNAME"

# Generate certificate
openssl req -x509 -nodes -days $DAYS \
  -newkey rsa:2048 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -subj "/CN=$HOSTNAME/O=Maestro/C=FR" \
  -addext "subjectAltName=IP:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"

echo "Certificate generated:"
echo "  Cert: $CERT_FILE"
echo "  Key:  $KEY_FILE"
echo "  Valid for: $DAYS days"

# Add to .env if not already set
if [ -f "$ENV_FILE" ]; then
  if grep -q "MAESTRO_SSL_CERT" "$ENV_FILE"; then
    sed -i "s|^MAESTRO_SSL_CERT=.*|MAESTRO_SSL_CERT=$CERT_FILE|" "$ENV_FILE"
    sed -i "s|^MAESTRO_SSL_KEY=.*|MAESTRO_SSL_KEY=$KEY_FILE|" "$ENV_FILE"
  else
    echo "" >> "$ENV_FILE"
    echo "MAESTRO_SSL_CERT=$CERT_FILE" >> "$ENV_FILE"
    echo "MAESTRO_SSL_KEY=$KEY_FILE" >> "$ENV_FILE"
  fi
else
  echo "MAESTRO_SSL_CERT=$CERT_FILE" >> "$ENV_FILE"
  echo "MAESTRO_SSL_KEY=$KEY_FILE" >> "$ENV_FILE"
fi

echo ""
echo "SSL configuration added to $ENV_FILE"
echo "Restart the server to enable HTTPS."
