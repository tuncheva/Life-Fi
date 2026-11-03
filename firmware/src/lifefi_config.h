/* Every tunable of the firmware. Values tagged [H] are heuristic starting
 * points to tune on recordings (see docs/research/csi-people-counting.md). */
#pragma once

#define LIFEFI_FW_VERSION "0.1.0"

/* ---- Wi-Fi link ------------------------------------------------------- */

/* Credentials live in the git-ignored wifi_secrets.h (copy the .example).
 * With no SSID the firmware sniffs the strongest access point instead. */
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#endif
#ifndef LIFEFI_WIFI_SSID
#define LIFEFI_WIFI_SSID ""
#endif
#ifndef LIFEFI_WIFI_PASSWORD
#define LIFEFI_WIFI_PASSWORD ""
#endif
#ifndef LIFEFI_SNIFF_SSID
#define LIFEFI_SNIFF_SSID ""
#endif

#ifndef LIFEFI_COUNTRY
#define LIFEFI_COUNTRY "BG"             /* Wi-Fi regulatory domain: channels 1-13 */
#endif
#define LIFEFI_CONNECT_TIMEOUT_MS 20000 /* then fall back to sniffer mode */

/* ---- Raw CSI stream (stream.c) ---------------------------------------- */

#define LIFEFI_NODE_ID            1
#define LIFEFI_STREAM_PORT        5006   /* board listens here for "LFSUB" */
#define LIFEFI_STREAM_TIMEOUT_MS  5000   /* stop streaming without a fresh LFSUB */
#define LIFEFI_PING_INTERVAL_MS   10    /* router replies = CSI samples, ~100 Hz */

/* ---- Signal processing ------------------------------------------------ */

#define LIFEFI_NSC             52    /* LLTF subcarriers k = -26..-1, +1..+26 */
#define LIFEFI_WINDOW_MS       1000  /* one feature window per second */
#define LIFEFI_MIN_PACKETS     5     /* windows with fewer packets are skipped */
#define LIFEFI_WARMUP_WINDOWS  3     /* ignored after boot / recalibration */
#define LIFEFI_CALIB_WINDOWS   20    /* empty-room calibration length, s */
#define LIFEFI_ACTIVE_K        4.0f  /* subcarrier active: var > K x empty var [H] */
#define LIFEFI_SMOOTH_WINDOWS  8     /* count score = mean of the last N windows */
#define LIFEFI_COUNT_MEDIAN    5     /* shown count = median of the last N raw counts */

/* ---- Presence --------------------------------------------------------- */

/* Each threshold is the larger of a floor and the empty-room P90 scaled [H] */
#define LIFEFI_MOTION_ON_MIN    1.8f
#define LIFEFI_MOTION_ON_SCALE  1.5f
#define LIFEFI_ACTIVE_ON_MIN    0.20f
#define LIFEFI_ACTIVE_ON_MARGIN 0.15f
#define LIFEFI_DEV_ON_MIN       0.005f
#define LIFEFI_DEV_ON_SCALE     3.0f
#define LIFEFI_DEV_OFF_RATIO    0.6f

#define LIFEFI_PRESENCE_HOLD_S   30  /* no motion this long (+ profile back to empty) -> EMPTY */
#define LIFEFI_UNCERTAIN_AFTER_S 300 /* present but no motion this long -> UNCERTAIN */

/* ---- Count -------------------------------------------------------------- */

/* Smoothed motion score at which 2 / 3 / 4+ people are assumed, used until
 * `learn` has stored at least two levels [H] */
#define LIFEFI_COUNT2_SCORE  4.0f
#define LIFEFI_COUNT3_SCORE  7.0f
#define LIFEFI_COUNT4_SCORE  11.0f
#define LIFEFI_MAX_COUNT     5
#define LIFEFI_LEARN_WINDOWS 30 /* seconds recorded by `learn N` */

/* ---- Fixed transmitter (docs/hardware/fixed-transmitter.md) ------------ */

/* A second ESP32 built with -DLIFEFI_ROLE_TX=1 (envs *_tx) sends ESP-NOW
 * broadcasts at HT20 MCS0 from a fixed MAC 1A:4C:46:54:58:<id>. The receiver
 * looks for that MAC prefix at boot and, if found, takes its CSI from it. */
#ifndef LIFEFI_ROLE_TX
#define LIFEFI_ROLE_TX 0
#endif
#ifndef LIFEFI_TX_CHANNEL
#define LIFEFI_TX_CHANNEL 11            /* default; `channel N` on the TX changes it */
#endif
#ifndef LIFEFI_TX_RATE_HZ
#define LIFEFI_TX_RATE_HZ 100           /* frames per second; `rate N`, LIFEFI_TX_RATE_MIN-500 */
#endif
#ifndef LIFEFI_TX_ID
#define LIFEFI_TX_ID 1                  /* last MAC byte */
#endif
#ifndef LIFEFI_TX_LED_GPIO
#define LIFEFI_TX_LED_GPIO -1           /* status LED, -1 = none */
#endif
#ifndef LIFEFI_TX_LED_ACTIVE_LOW
#define LIFEFI_TX_LED_ACTIVE_LOW 0
#endif
#define LIFEFI_TX_MAC_PREFIX { 0x1A, 0x4C, 0x46, 0x54, 0x58 } /* "LFTX", locally administered */

/* Receiver: probe all channels for a fixed transmitter at boot (also needs
 * the `tx` setting on, the default; `tx off` turns it off) */
#ifndef LIFEFI_TX_PROBE
#define LIFEFI_TX_PROBE 1
#endif
#define LIFEFI_TX_PROBE_FIRST_MS 400    /* on LIFEFI_TX_CHANNEL */
#define LIFEFI_TX_PROBE_MS       200    /* on each other channel */
#define LIFEFI_TX_PROBE_MIN      5      /* frames needed to lock */
/* The slowest rate the TX accepts. The probe must see it on any channel with
 * room for lost frames and the channel-switch settle time: at 50 Hz a 200 ms
 * listen expects 10 frames, twice LIFEFI_TX_PROBE_MIN. */
#define LIFEFI_TX_RATE_MIN       50
_Static_assert(LIFEFI_TX_RATE_MIN * LIFEFI_TX_PROBE_MS >= 2 * LIFEFI_TX_PROBE_MIN * 1000,
               "the receiver's probe could miss a transmitter at LIFEFI_TX_RATE_MIN");
_Static_assert(LIFEFI_TX_RATE_HZ >= LIFEFI_TX_RATE_MIN, "LIFEFI_TX_RATE_HZ below LIFEFI_TX_RATE_MIN");
