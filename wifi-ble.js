const bleno = require('@abandonware/bleno');
const fs = require("fs");
const { exec } = require("child_process");
const os = require("os");

const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
const WIFI_CHAR_UUID = "abcdef01-1234-5678-1234-56789abcdef0";
const STATUS_CHAR_UUID = "abcdef02-1234-5678-1234-56789abcdef0";

// ---- helper: get current IP ----
function getCurrentIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "0.0.0.0";
}

// ---- Status notify characteristic ----
let updateStatus;
class StatusCharacteristic extends bleno.Characteristic {
  constructor() {
    super({
      uuid: STATUS_CHAR_UUID,
      properties: ["notify"],   // only notify (no write)
    });
  }

  onSubscribe(maxValueSize, updateValueCallback) {
    updateStatus = updateValueCallback;
    console.log("📡 Android subscribed for status updates");
    this.sendStatus("READY");
  }

  onUnsubscribe() {
    updateStatus = null;
  }

  sendStatus(msg) {
    if (updateStatus) {
      updateStatus(Buffer.from(msg, "utf8"));
      console.log("➡️ Status sent:", msg);
    }
  }
}

// ---- WiFi write characteristic ----
class WifiCharacteristic extends bleno.Characteristic {
  constructor(statusChar) {
    super({
      uuid: WIFI_CHAR_UUID,
      properties: ["write"],   // only WiFi char is writable
    });
    this.statusChar = statusChar;
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
    const msg = data.toString("utf8").trim();
    console.log("📥 Received:", msg);

    try {
      // ✅ Special command: GET_IP
      if (msg === "GET_IP") {
        const ip = getCurrentIP();
        this.statusChar.sendStatus("IP:" + ip);
        console.log("Return current IP", ip)
        console.log("this.RESULT_SUCCESS", this.RESULT_SUCCESS)
        return callback(this.RESULT_SUCCESS);
      }

      // ✅ Otherwise, expect WiFi credentials: ssid|password
      const [ssid, password] = msg.split("|");

      if (!ssid || !password) {
        this.statusChar.sendStatus("ERROR:INVALID_FORMAT");
        return callback(this.RESULT_SUCCESS);
      }

      const confPath = "/etc/wpa_supplicant/wpa_supplicant.conf";

    // ---- default template (up to your 2 admin networks) ----
    const defaultPart = `ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
network={
        ssid="admin"
        #psk="admin1234"
        psk=1fc8cef73cab8d8a7a1d1cd8e6de2ae8224bc16f8f266e10c8670113bc461c3c
        priority=10
}


network={
    ssid="admin"
    psk="12345678"
}
`;

    // ---- new WiFi (always overwrite last) ----
    const newConf = `
network={
    ssid="${ssid}"
    psk="${password}"
}
`;

      fs.writeFileSync(confPath, defaultPart + newConf);

      console.log("✅ WiFi overwritten with:", ssid);
      this.statusChar.sendStatus("WIFI_SAVED");

      exec("wpa_cli -i wlan0 reconfigure", (err) => {
        if (err) {
          console.error("❌ WiFi reconfigure failed:", err);
          this.statusChar.sendStatus("WIFI_FAIL");
        } else {
          console.log("🌐 Trying WiFi connection...");
          this.statusChar.sendStatus("WIFI_CONNECTING");
          setTimeout(() => {
            this.statusChar.sendStatus("IP:" + getCurrentIP());
          }, 5000);
        }
      });
    } catch (e) {
      console.error("❌ Error:", e);
      this.statusChar.sendStatus("ERROR");
    }

    callback(this.RESULT_SUCCESS);
  }
}

// ---- BLE Setup ----
const statusChar = new StatusCharacteristic();
const wifiChar = new WifiCharacteristic(statusChar);

bleno.on("stateChange", (state) => {
  if (state === "poweredOn") {
    console.log("🚀 BLE ON, advertising...");
    bleno.startAdvertising("WaddleBeats-01", [SERVICE_UUID]);
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on("advertisingStart", (err) => {
  if (!err) {
    bleno.setServices([
      new bleno.PrimaryService({
        uuid: SERVICE_UUID,
        characteristics: [wifiChar, statusChar],
      }),
    ]);
    console.log("✅ BLE Service ready");
  }
});
