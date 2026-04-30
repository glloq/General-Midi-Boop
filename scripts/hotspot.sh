#!/bin/bash
# =============================================================================
# General-Midi-Boop — WiFi & Hotspot management wrapper
# =============================================================================
#
# Single entry point for managing WiFi on the Raspberry Pi via NetworkManager
# (nmcli). Covers both the hotspot (AP) profile and the regular WiFi client
# (scan / connect / disconnect / forget saved profiles).
#
# This script is the ONE binary the application is allowed to run via sudo
# (see the sudoers rule installed by scripts/Install.sh). The filename is
# kept as `hotspot.sh` for backward compatibility with the deployed sudoers
# rule, even though the script now also handles WiFi-client operations.
#
# Sub-commands:
#   status                                -> JSON state on stdout
#   enable  <ssid> <pwd> [band] [channel] -> create/update + activate hotspot
#   disable                               -> stop hotspot, let WiFi reconnect
#   wifi-scan                             -> list nearby APs (rescan)
#   wifi-connect <ssid> [password]        -> connect to a network
#   wifi-disconnect                       -> disconnect from WiFi (no hotspot)
#   wifi-forget <ssid>                    -> delete a saved profile
#   wifi-saved                            -> list saved (non-hotspot) profiles
#
# All sub-commands print a single-line JSON object to stdout and exit 0 on
# success; on failure they exit non-zero with an `{"error":"..."}` payload.
# =============================================================================

set -u

HOTSPOT_NAME="gmboop-hotspot"
WIFI_IFACE="${HOTSPOT_IFACE:-wlan0}"

json_escape() {
  # Minimal JSON string escaping for nmcli output reuse.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' \
    | tr -d '\r\n'
}

emit_error() {
  printf '{"success":false,"error":"%s"}\n' "$(json_escape "$1")"
  exit 1
}

require_nmcli() {
  command -v nmcli >/dev/null 2>&1 || emit_error "nmcli not installed (NetworkManager required)"
}

cmd_status() {
  require_nmcli

  local active hotspot_active wifi_name
  hotspot_active="false"
  wifi_name=""

  # Check whether our hotspot profile is currently up.
  if nmcli -t -f NAME connection show --active 2>/dev/null | grep -Fxq "$HOTSPOT_NAME"; then
    hotspot_active="true"
  fi

  # Currently active wifi connection on the target interface (if any).
  active="$(nmcli -t -f NAME,TYPE,DEVICE connection show --active 2>/dev/null \
    | awk -F: -v iface="$WIFI_IFACE" '$2=="802-11-wireless" && $3==iface {print $1; exit}')"
  if [ -n "${active:-}" ] && [ "$active" != "$HOTSPOT_NAME" ]; then
    wifi_name="$active"
  fi

  printf '{"success":true,"hotspotActive":%s,"wifiActive":"%s","interface":"%s"}\n' \
    "$hotspot_active" "$(json_escape "$wifi_name")" "$(json_escape "$WIFI_IFACE")"
}

cmd_enable() {
  require_nmcli

  local ssid="${1:-}" password="${2:-}" band="${3:-bg}" channel="${4:-}"
  if [ -z "$ssid" ]; then emit_error "ssid is required"; fi
  if [ -z "$password" ] || [ "${#password}" -lt 8 ]; then
    emit_error "password must be at least 8 characters (WPA2)"
  fi
  case "$band" in a|bg) ;; *) emit_error "band must be 'a' or 'bg'";; esac

  # Drop any previous instance so we always rebuild from current config.
  nmcli connection delete "$HOTSPOT_NAME" >/dev/null 2>&1 || true

  if ! nmcli connection add type wifi ifname "$WIFI_IFACE" con-name "$HOTSPOT_NAME" \
        autoconnect no ssid "$ssid" >/dev/null 2>&1; then
    emit_error "failed to create hotspot profile"
  fi

  nmcli connection modify "$HOTSPOT_NAME" \
    802-11-wireless.mode ap \
    802-11-wireless.band "$band" \
    ipv4.method shared \
    ipv6.method ignore \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$password" >/dev/null 2>&1 \
    || { nmcli connection delete "$HOTSPOT_NAME" >/dev/null 2>&1 || true;
         emit_error "failed to configure hotspot profile"; }

  if [ -n "$channel" ]; then
    nmcli connection modify "$HOTSPOT_NAME" 802-11-wireless.channel "$channel" >/dev/null 2>&1 || true
  fi

  # Bringing the hotspot up implicitly takes wlan0 away from the client
  # connection — NetworkManager only allows one active profile per device.
  if ! nmcli connection up "$HOTSPOT_NAME" >/dev/null 2>&1; then
    emit_error "failed to activate hotspot (nmcli connection up failed)"
  fi

  printf '{"success":true,"hotspotActive":true,"ssid":"%s"}\n' "$(json_escape "$ssid")"
}

cmd_disable() {
  require_nmcli

  # Stop the AP profile if active. Ignore errors (already down is fine).
  nmcli connection down "$HOTSPOT_NAME" >/dev/null 2>&1 || true

  # Best-effort: re-activate the most recently used wifi-client profile so
  # the user doesn't have to wait for the autoconnect timer. We pick the
  # newest 802-11-wireless profile other than our hotspot.
  local target
  target="$(nmcli -t -f NAME,TYPE,TIMESTAMP connection show 2>/dev/null \
    | awk -F: -v hs="$HOTSPOT_NAME" '$2=="802-11-wireless" && $1!=hs {print $3":"$1}' \
    | sort -t: -k1,1nr | head -n1 | cut -d: -f2-)"

  if [ -n "${target:-}" ]; then
    nmcli connection up "$target" >/dev/null 2>&1 || true
  fi

  printf '{"success":true,"hotspotActive":false,"wifiActive":"%s"}\n' \
    "$(json_escape "${target:-}")"
}

cmd_wifi_scan() {
  require_nmcli

  # Trigger a rescan; ignore errors (busy / already scanning).
  nmcli -t device wifi rescan ifname "$WIFI_IFACE" >/dev/null 2>&1 || true
  # Brief settle for the scan results to land.
  sleep 1

  printf '{"success":true,"networks":['
  local first=1 in_use ssid security signal active
  while IFS=: read -r in_use ssid security signal; do
    [ -z "${ssid:-}" ] && continue
    if [ "$first" -eq 0 ]; then printf ','; fi
    first=0
    active="false"
    [ "$in_use" = "*" ] && active="true"
    printf '{"ssid":"%s","security":"%s","signal":%d,"active":%s}' \
      "$(json_escape "$ssid")" \
      "$(json_escape "${security:-}")" \
      "${signal:-0}" \
      "$active"
  done < <(nmcli -t -f IN-USE,SSID,SECURITY,SIGNAL device wifi list ifname "$WIFI_IFACE" 2>/dev/null)
  printf ']}\n'
}

cmd_wifi_connect() {
  require_nmcli

  local ssid="${1:-}" password="${2:-}"
  if [ -z "$ssid" ]; then emit_error "ssid is required"; fi

  # Refuse to clobber the hotspot profile if the caller passes that name.
  if [ "$ssid" = "$HOTSPOT_NAME" ]; then
    emit_error "ssid conflicts with the hotspot profile name"
  fi

  # Stop the hotspot first if it's up — only one profile can own wlan0.
  if nmcli -t -f NAME connection show --active 2>/dev/null | grep -Fxq "$HOTSPOT_NAME"; then
    nmcli connection down "$HOTSPOT_NAME" >/dev/null 2>&1 || true
  fi

  local out rc
  if [ -n "$password" ]; then
    out="$(nmcli -w 30 device wifi connect "$ssid" password "$password" ifname "$WIFI_IFACE" 2>&1)"
    rc=$?
  else
    out="$(nmcli -w 30 device wifi connect "$ssid" ifname "$WIFI_IFACE" 2>&1)"
    rc=$?
  fi

  if [ $rc -ne 0 ]; then
    emit_error "wifi connect failed: $(echo "$out" | head -n1)"
  fi

  printf '{"success":true,"wifiActive":"%s"}\n' "$(json_escape "$ssid")"
}

cmd_wifi_disconnect() {
  require_nmcli
  # Bring down only the wifi-client profile on our interface; do not touch
  # the hotspot profile (it shouldn't be up here, but be safe).
  local active
  active="$(nmcli -t -f NAME,TYPE,DEVICE connection show --active 2>/dev/null \
    | awk -F: -v iface="$WIFI_IFACE" -v hs="$HOTSPOT_NAME" \
        '$2=="802-11-wireless" && $3==iface && $1!=hs {print $1; exit}')"
  if [ -n "${active:-}" ]; then
    nmcli connection down "$active" >/dev/null 2>&1 || true
  fi
  printf '{"success":true,"wifiActive":""}\n'
}

cmd_wifi_forget() {
  require_nmcli
  local ssid="${1:-}"
  if [ -z "$ssid" ]; then emit_error "ssid is required"; fi
  if [ "$ssid" = "$HOTSPOT_NAME" ]; then
    emit_error "refusing to forget the hotspot profile"
  fi
  nmcli connection delete "$ssid" >/dev/null 2>&1 \
    || emit_error "no saved profile named '$ssid'"
  printf '{"success":true,"forgotten":"%s"}\n' "$(json_escape "$ssid")"
}

cmd_wifi_saved() {
  require_nmcli

  printf '{"success":true,"profiles":['
  local first=1 name type autoconnect
  while IFS=: read -r name type autoconnect; do
    [ -z "${name:-}" ] && continue
    [ "$type" != "802-11-wireless" ] && continue
    [ "$name" = "$HOTSPOT_NAME" ] && continue
    if [ "$first" -eq 0 ]; then printf ','; fi
    first=0
    local ac="false"
    [ "$autoconnect" = "yes" ] && ac="true"
    printf '{"name":"%s","autoconnect":%s}' "$(json_escape "$name")" "$ac"
  done < <(nmcli -t -f NAME,TYPE,AUTOCONNECT connection show 2>/dev/null)
  printf ']}\n'
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    status)          cmd_status ;;
    enable)          cmd_enable "$@" ;;
    disable)         cmd_disable ;;
    wifi-scan)       cmd_wifi_scan ;;
    wifi-connect)    cmd_wifi_connect "$@" ;;
    wifi-disconnect) cmd_wifi_disconnect ;;
    wifi-forget)     cmd_wifi_forget "$@" ;;
    wifi-saved)      cmd_wifi_saved ;;
    *)               emit_error "unknown sub-command: ${sub:-<empty>} (expected status|enable|disable|wifi-scan|wifi-connect|wifi-disconnect|wifi-forget|wifi-saved)" ;;
  esac
}

main "$@"
