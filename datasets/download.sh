#!/usr/bin/env bash
# Re-downloads the openly available datasets from
# docs/research/training-data-sources.md into datasets/raw/ (~10 GB unpacked).
# Needs: git, curl, unzip, tar (on Windows, System32\tar.exe handles the .rar).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw && cd raw

zenodo() { curl -sSL -o "$2" "https://zenodo.org/records/$1/files/$3?download=1"; }

git clone --depth 1 https://github.com/AlbanyArmenta0711/Embedded_WiFi_Sensing.git E1_Embedded_WiFi_Sensing &

(mkdir -p E2_WiFall && cd E2_WiFall \
  && curl -sSL -o WiFall.zip https://huggingface.co/datasets/RS2002/WiFall/resolve/main/WiFall.zip \
  && curl -sSL -o README.md https://huggingface.co/datasets/RS2002/WiFall/resolve/main/README.md \
  && unzip -q WiFall.zip && rm WiFall.zip) &

(git clone --depth 1 --filter=blob:none --sparse https://github.com/francescopace/espectre.git E3_ESPectre \
  && git -C E3_ESPectre sparse-checkout set data) &

(mkdir -p E4_3DO && zenodo 10925351 E4_3DO/3DO.zip 3DO.zip \
  && unzip -q E4_3DO/3DO.zip -d E4_3DO && rm E4_3DO/3DO.zip) &

(mkdir -p E5_Wallhack1.8k && zenodo 13950918 E5_Wallhack1.8k/wallhack1.8k.zip wallhack1.8k.zip \
  && unzip -q E5_Wallhack1.8k/wallhack1.8k.zip -d E5_Wallhack1.8k && rm E5_Wallhack1.8k/wallhack1.8k.zip) &

(mkdir -p E6_OpenCSI && for f in README.md DATASHEET.md opencsi-dataset.tar.gz; do zenodo 19861032 "E6_OpenCSI/$f" "$f"; done \
  && tar -xzf E6_OpenCSI/opencsi-dataset.tar.gz -C E6_OpenCSI && rm E6_OpenCSI/opencsi-dataset.tar.gz) &

(mkdir -p E7_ESP32_LOS_NLOS_HAR && curl -sSL -o E7_ESP32_LOS_NLOS_HAR/dataset.zip \
  "https://data.mendeley.com/public-files/datasets/x4x5xttvwt/files/1c84fdd2-4105-43d2-868a-2394c1287593/file_downloaded" \
  && unzip -q E7_ESP32_LOS_NLOS_HAR/dataset.zip -d E7_ESP32_LOS_NLOS_HAR && rm E7_ESP32_LOS_NLOS_HAR/dataset.zip) &

(git clone --depth 1 https://github.com/AutoSmartGroup/ESP-Fi-HAR.git E8_ESP-Fi-HAR \
  && tar -xf E8_ESP-Fi-HAR/ESP-Fi_dataset.rar -C E8_ESP-Fi-HAR && rm E8_ESP-Fi-HAR/ESP-Fi_dataset.rar) &

(mkdir -p E10_RF_ESP32 && zenodo 23053384 E10_RF_ESP32/RF_ESP32_Dataset.zip Mohammed-Baqir/RF_ESP32_Dataset-v1.0.1.zip \
  && unzip -q E10_RF_ESP32/RF_ESP32_Dataset.zip -d E10_RF_ESP32 && rm E10_RF_ESP32/RF_ESP32_Dataset.zip) &

git clone --depth 1 https://github.com/Ken35943/SG_106B07.git E15_SG_106B07 &

wait
du -sh -- */
