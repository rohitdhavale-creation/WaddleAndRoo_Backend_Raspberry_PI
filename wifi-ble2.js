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
    console.log(" ^=^s  Android subscribed for status updates");
    this.sendStatus("READY");
  }

  onUnsubscribe() {
    updateStatus = null;
  }

  sendStatus(msg) {
    if (updateStatus) {
      updateStatus(Buffer.from(msg, "utf8"));
      console.log(" ^~   ^o Status sent:", msg);
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
  console.log(" ^=^s  Received WiFi:", msg);

  try {
    const [ssid, password] = msg.split("|");

    if (!ssid || !password) {
      this.statusChar.sendStatus("ERROR:INVALID_FORMAT");
      return callback(this.RESULT_SUCCESS);
    }

    const confPath = "/etc/wpa_supplicant/wpa_supplicant.conf";
    let fileContent = fs.readFileSync(confPath, "utf8");

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

    // overwrite file with default + new wifi
    fs.writeFileSync(confPath, defaultPart + newConf);

    console.log(" ^|^e WiFi overwritten with:", ssid);
    this.statusChar.sendStatus("WIFI_SAVED");

    exec("wpa_cli -i wlan0 reconfigure", (err) => {
      if (err) {
        console.error(" ^}^l WiFi reconfigure failed:", err);
        this.statusChar.sendStatus("WIFI_FAIL");
      } else {
        console.log(" ^=^z^` Trying WiFi connection...");
        this.statusChar.sendStatus("WIFI_CONNECTING");
      }
    });
  } catch (e) {
    console.error(" ^}^l Error:", e);
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
    console.log(" ^=^z^` BLE ON, advertising...");
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
    console.log(" ^|^e BLE Service ready");
  }
});

