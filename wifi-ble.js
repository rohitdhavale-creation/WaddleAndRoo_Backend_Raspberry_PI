
const bleno = require('@abandonware/bleno');

const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");

const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
const WIFI_CHAR_UUID = "abcdef01-1234-5678-1234-56789abcdef0";
const STATUS_CHAR_UUID = "abcdef02-1234-5678-1234-56789abcdef0";

// ---- Status notify characteristic ----
let updateStatus;
class StatusCharacteristic extends bleno.Characteristic {
  constructor() {
    super({
      uuid: STATUS_CHAR_UUID,
      properties: ["notify"],
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
      properties: ["write"],
    });
    this.statusChar = statusChar;
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
    const msg = data.toString("utf8").trim();
    console.log("📥 Received WiFi:", msg);

    try {
      const [ssid, password] = msg.split("|");

      if (!ssid || !password) {
        this.statusChar.sendStatus("ERROR:INVALID_FORMAT");
        return callback(this.RESULT_SUCCESS);
      }

      const uniqueFile = path.join(
        "/etc/wpa_supplicant/",
        `wpa_${Date.now()}.conf`
      );

      const wpaConf = `
network={
    ssid="${ssid}"
    psk="${password}"
}
`;

      fs.writeFileSync(uniqueFile, wpaConf);
      fs.appendFileSync("/etc/wpa_supplicant/wpa_supplicant.conf", wpaConf);
      console.log("✅ WiFi saved to:", uniqueFile);

      this.statusChar.sendStatus("WIFI_SAVED");

      exec("wpa_cli -i wlan0 reconfigure", (err) => {
        if (err) {
          console.error("❌ WiFi reconfigure failed:", err);
          this.statusChar.sendStatus("WIFI_FAIL");
        } else {
          console.log("🚀 Trying WiFi connection...");
          this.statusChar.sendStatus("WIFI_CONNECTING");
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
