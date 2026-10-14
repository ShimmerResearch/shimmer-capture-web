# Bluetooth module firmware (IF820)

Where the one Shimmer3R Bluetooth module image this site offers to customers goes.

**None is bundled yet**, so the feature is switched off: with no `manifest.json` the page never offers an
update. Which release to ship is still being decided (v1.4.18.18 has the broken transparent mode; an
Infineon test build cannot be redistributed without their agreement). The mock link (`?mock=1`) uses a
synthetic image under `common/dev/if820-mock/` instead.
`common/bt-module-update.js` offers it to any sensor whose module reports an
older version, and runs it over BLE. See "Bluetooth module update" in
`common/README.md`.

**Keep exactly one image here.** The page has no version picker by design:
whatever `manifest.json` names is what every customer with an older module
is offered once this is deployed. That makes replacing the image a release
decision, not a file drop.

## Adding or replacing the image

1. Remove the old `.ota.bin` and add the new one. Use the `.ota.bin` from the
   Ezurio EZ-Serial release package, the same file WsOtaUpgrade takes, in the
   antenna variant the Shimmer3R uses: **INT-ANT**.
2. Regenerate `manifest.json` in the same commit:

   ```bash
   python -c "import zlib,json,os,sys; f=sys.argv[1]; b=open(f,'rb').read(); print(json.dumps({'version':sys.argv[2],'file':os.path.basename(f),'bytes':len(b),'crc32':'0x%08x'%(zlib.crc32(b)&0xffffffff),'module':'Ezurio Vela IF820 (Infineon CYW20820), EZ-Serial','variant':'INT-ANT','released':sys.argv[3]},indent=2))" image.ota.bin 1.4.x.y YYYY-MM-DD > manifest.json
   ```

   The page refuses to send an image whose size or CRC-32 does not match the
   manifest, so a stale manifest fails safe: nothing is sent.

3. Check that the Shimmer3R firmware supports the new module version. The
   firmware picks its classic-Bluetooth data path from the module version
   (`BT_selectDataPath()` in `shimmer3r-firmware`'s `CYW20820.c`). The page
   only offers the update to sensors on LogAndStream v1.01.022 or later (the
   SDK's `IF820_OTA_MIN_SENSOR_FIRMWARE`); a newer module may need that floor
   raised.

Removing both files turns the feature off again: with no manifest, nothing is
ever offered. Adding them means dropping the verify pass's "no module image yet"
check in the same commit.
