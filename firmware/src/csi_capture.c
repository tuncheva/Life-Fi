#include "csi_capture.h"

#include <string.h>
#include "esp_check.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/task.h"

static const char *TAG = "csi";

#define CSI_QUEUE_LEN 64
#define SURVEY_SLOTS  24

static QueueHandle_t s_queue;
static uint8_t s_target[6];
static volatile bool s_target_set;
static csi_counters_t s_cnt;
static volatile bool s_surveying;
static csi_survey_entry_t s_survey[SURVEY_SLOTS];
static int s_survey_n;

static void survey_add(const wifi_csi_info_t *info)
{
    if (info->len < 128 || info->rx_ctrl.cwb != 0) {
        return;
    }
    for (int i = 0; i < s_survey_n; i++) {
        if (memcmp(s_survey[i].mac, info->mac, 6) == 0) {
            s_survey[i].frames++;
            s_survey[i].rssi = info->rx_ctrl.rssi;
            return;
        }
    }
    if (s_survey_n < SURVEY_SLOTS) {
        csi_survey_entry_t *e = &s_survey[s_survey_n++];
        memcpy(e->mac, info->mac, 6);
        e->frames = 1;
        e->rssi = info->rx_ctrl.rssi;
    }
}

/* Runs in the Wi-Fi task: copy and return, never block */
static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    if (info == NULL || info->buf == NULL) {
        return;
    }
    if (s_surveying) {
        survey_add(info);
    }
    if (!s_target_set) {
        return;
    }
    if (memcmp(info->mac, s_target, sizeof(s_target)) != 0) {
        s_cnt.other_mac++;
        return;
    }
    /* LLTF always comes first in buf; 40 MHz frames use a different layout */
    if (info->len < 128 || info->rx_ctrl.cwb != 0) {
        s_cnt.rejected++;
        return;
    }

    csi_packet_t p;
    p.ts_us = esp_timer_get_time();
    memcpy(p.mac, info->mac, sizeof(p.mac));
    p.rssi = info->rx_ctrl.rssi;
    p.noise_floor = info->rx_ctrl.noise_floor;
    p.sig_mode = info->rx_ctrl.sig_mode;
    p.mcs = info->rx_ctrl.mcs;
    p.cwb = info->rx_ctrl.cwb;
    p.stbc = info->rx_ctrl.stbc;
    p.channel = info->rx_ctrl.channel;
    p.secondary_channel = info->rx_ctrl.secondary_channel;
    p.first_word_invalid = info->first_word_invalid;
    p.rx_seq = info->rx_seq;
    p.len = info->len < CSI_BUF_MAX ? info->len : CSI_BUF_MAX;
    memcpy(p.buf, info->buf, p.len);

    s_cnt.received++;
    if (xQueueSend(s_queue, &p, 0) != pdTRUE) {
        s_cnt.queue_drops++;
    }
}

esp_err_t csi_capture_start(void)
{
    if (s_queue == NULL) {
        s_queue = xQueueCreate(CSI_QUEUE_LEN, sizeof(csi_packet_t));
        ESP_RETURN_ON_FALSE(s_queue != NULL, ESP_ERR_NO_MEM, TAG, "csi queue");
    }

    /* LLTF for every frame, plus HT-LTF on HT frames for the raw stream;
     * unmerged and unfiltered so subcarriers stay independent
     * (docs/plan/csi-for-models.md §2.1). Auto-scaling stays on: its
     * per-packet gain is cancelled by normalising every packet. */
    wifi_csi_config_t cfg = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = false,
        .ltf_merge_en = false,
        .channel_filter_en = false,
        .manu_scale = false,
        .shift = 0,
    };
    ESP_RETURN_ON_ERROR(esp_wifi_set_csi_config(&cfg), TAG, "csi config");
    ESP_RETURN_ON_ERROR(esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL), TAG, "csi callback");
    ESP_RETURN_ON_ERROR(esp_wifi_set_csi(true), TAG, "csi enable");
    return ESP_OK;
}

void csi_capture_set_target(const uint8_t mac[6])
{
    s_target_set = false;
    memcpy(s_target, mac, sizeof(s_target));
    s_target_set = true;
}

void csi_capture_survey_start(void)
{
    s_surveying = false;
    s_survey_n = 0;
    s_surveying = true;
}

int csi_capture_survey_stop(csi_survey_entry_t *out, int max)
{
    s_surveying = false;
    vTaskDelay(pdMS_TO_TICKS(20));   /* let a callback in flight finish */
    int n = s_survey_n < max ? s_survey_n : max;
    for (int i = 0; i < n; i++) {    /* partial selection sort, busiest first */
        int best = i;
        for (int j = i + 1; j < s_survey_n; j++) {
            if (s_survey[j].frames > s_survey[best].frames) {
                best = j;
            }
        }
        csi_survey_entry_t t = s_survey[i];
        s_survey[i] = s_survey[best];
        s_survey[best] = t;
        out[i] = s_survey[i];
    }
    return n;
}

QueueHandle_t csi_capture_queue(void)
{
    return s_queue;
}

void csi_capture_counters(csi_counters_t *out)
{
    *out = s_cnt;
}
