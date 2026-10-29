/* CSI capture: Wi-Fi driver callback -> queue of raw LLTF packets. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "csi_window.h"
#include "lifefi_config.h"

typedef struct {
    uint32_t received;        /* frames from the target transmitter */
    uint32_t other_mac;       /* frames from anyone else (ignored) */
    uint32_t rejected;        /* too short or 40 MHz */
    uint32_t queue_drops;
} csi_counters_t;

/* One transmitter seen during a survey */
typedef struct {
    uint8_t mac[6];
    uint32_t frames;          /* usable CSI frames (20 MHz, LLTF present) */
    int8_t rssi;              /* of the last frame */
} csi_survey_entry_t;

/* Enable CSI in the Wi-Fi driver. Wi-Fi must be started. */
esp_err_t csi_capture_start(void);

/* Count usable CSI frames per transmitter until stopped. Beacons sent at
 * 802.11b rates carry no CSI, so the busiest OFDM transmitter is often a
 * better source than the strongest AP. */
void csi_capture_survey_start(void);

/* Stop the survey; copies up to max entries, busiest first; returns the count. */
int csi_capture_survey_stop(csi_survey_entry_t *out, int max);

/* Only frames transmitted by this MAC are queued; nothing is queued before. */
void csi_capture_set_target(const uint8_t mac[6]);

QueueHandle_t csi_capture_queue(void);
void csi_capture_counters(csi_counters_t *out);
