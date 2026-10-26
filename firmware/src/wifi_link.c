#include "wifi_link.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "ping/ping_sock.h"
#include "csi_capture.h"
#include "lifefi_config.h"

static const char *TAG = "link";

#define BIT_GOT_IP      BIT0
#define SCAN_MAX        20
#define SURVEY_CHANNELS 3     /* channels of the strongest APs to survey */
#define SURVEY_MS       3000
#define GOOD_RATE_HZ    10.0f /* an AP this busy is preferred over any client */

static EventGroupHandle_t s_events;
static esp_netif_t *s_netif;
static esp_ping_handle_t s_ping;
static volatile bool s_give_up;
static link_mode_t s_mode;
static uint8_t s_bssid[6];    /* the transmitter CSI is taken from */
static uint8_t s_channel;
static char s_ssid[33];
static volatile uint32_t s_ping_timeouts;
static volatile uint32_t s_disconnects;

static void on_ping_timeout(esp_ping_handle_t hdl, void *args)
{
    s_ping_timeouts++;
}

static void start_ping(void)
{
    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(s_netif, &ip) != ESP_OK || ip.gw.addr == 0) {
        ESP_LOGE(TAG, "no gateway address, cannot ping the router");
        return;
    }
    if (s_ping == NULL) {
        esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
        cfg.target_addr.type = IPADDR_TYPE_V4;
        cfg.target_addr.u_addr.ip4.addr = ip.gw.addr;
        cfg.count = ESP_PING_COUNT_INFINITE;
        cfg.interval_ms = LIFEFI_PING_INTERVAL_MS;
        /* A lost reply stalls the ping task for the whole timeout: keep it short */
        cfg.timeout_ms = 100;
        esp_ping_callbacks_t cbs = { .on_ping_timeout = on_ping_timeout };
        if (esp_ping_new_session(&cfg, &cbs, &s_ping) != ESP_OK) {
            ESP_LOGE(TAG, "could not create the ping session");
            s_ping = NULL;
            return;
        }
    }
    esp_ping_start(s_ping);
    ESP_LOGI(TAG, "pinging gateway " IPSTR " every %d ms", IP2STR(&ip.gw), LIFEFI_PING_INTERVAL_MS);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_mode == LINK_STATION && !s_give_up) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *d = data;
        s_disconnects++;
        xEventGroupClearBits(s_events, BIT_GOT_IP);
        if (s_ping != NULL) {
            esp_ping_stop(s_ping);
        }
        if (s_mode == LINK_STATION && !s_give_up) {
            ESP_LOGW(TAG, "disconnected (reason %d), reconnecting", d->reason);
            esp_wifi_connect();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        wifi_ap_record_t ap;
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            memcpy(s_bssid, ap.bssid, sizeof(s_bssid));
            s_channel = ap.primary;
            strlcpy(s_ssid, (const char *)ap.ssid, sizeof(s_ssid));
            csi_capture_set_target(ap.bssid);
            ESP_LOGI(TAG, "connected to \"%s\" (" MACSTR ") on channel %d, rssi %d",
                     s_ssid, MAC2STR(s_bssid), s_channel, ap.rssi);
        }
        start_ping();
        xEventGroupSetBits(s_events, BIT_GOT_IP);
    }
}

static int cmp_rssi_desc(const void *a, const void *b)
{
    return ((const wifi_ap_record_t *)b)->rssi - ((const wifi_ap_record_t *)a)->rssi;
}

static bool ssid_wanted(const wifi_ap_record_t *ap)
{
    return LIFEFI_SNIFF_SSID[0] == '\0' || strcmp((const char *)ap->ssid, LIFEFI_SNIFF_SSID) == 0;
}

static const wifi_ap_record_t *find_ap(const wifi_ap_record_t *recs, int n, const uint8_t *mac)
{
    for (int i = 0; i < n; i++) {
        if (memcmp(recs[i].bssid, mac, 6) == 0) {
            return &recs[i];
        }
    }
    return NULL;
}

/* Scan until at least one wanted AP is found; returns the AP count, recs sorted by RSSI */
static int scan_aps(wifi_ap_record_t *recs)
{
    for (;;) {
        uint16_t n = SCAN_MAX;
        wifi_scan_config_t sc = { 0 };
        if (esp_wifi_scan_start(&sc, true) != ESP_OK ||
            esp_wifi_scan_get_ap_records(&n, recs) != ESP_OK) {
            n = 0;
        }
        qsort(recs, n, sizeof(*recs), cmp_rssi_desc);
        int wanted = 0;
        for (int i = 0; i < n; i++) {
            if (i < 8) {
                ESP_LOGI(TAG, "  AP %-32s " MACSTR " ch %2d rssi %4d", (const char *)recs[i].ssid,
                         MAC2STR(recs[i].bssid), recs[i].primary, recs[i].rssi);
            }
            wanted += ssid_wanted(&recs[i]);
        }
        if (wanted > 0) {
            return n;
        }
        ESP_LOGW(TAG, "no usable access point found, rescanning in 5 s");
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

/* Pick the transmitter that gives the most CSI. Beacons at 802.11b rates
 * carry no CSI, so an idle AP may give almost nothing while a busy client
 * on the same channel gives plenty. A busy AP is still preferred: it
 * doesn't move. */
static esp_err_t start_sniffer(void)
{
    s_mode = LINK_SNIFFER;
    wifi_ap_record_t *recs = calloc(SCAN_MAX, sizeof(*recs));
    csi_survey_entry_t *seen = calloc(SCAN_MAX, sizeof(*seen));
    if (recs == NULL || seen == NULL) {
        free(recs);
        free(seen);
        return ESP_ERR_NO_MEM;
    }
    int n_ap = scan_aps(recs);

    uint8_t channels[SURVEY_CHANNELS];
    int n_ch = 0;
    for (int i = 0; i < n_ap && n_ch < SURVEY_CHANNELS; i++) {
        bool dup = false;
        for (int c = 0; c < n_ch; c++) {
            dup |= channels[c] == recs[i].primary;
        }
        if (ssid_wanted(&recs[i]) && !dup) {
            channels[n_ch++] = recs[i].primary;
        }
    }

    wifi_promiscuous_filter_t f = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_promiscuous_filter(&f));
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_promiscuous(true));

    /* Fallback if nothing gives CSI: the strongest wanted AP */
    const wifi_ap_record_t *first = NULL;
    for (int i = 0; i < n_ap && first == NULL; i++) {
        first = ssid_wanted(&recs[i]) ? &recs[i] : NULL;
    }
    uint8_t best_mac[6];
    memcpy(best_mac, first->bssid, 6);
    uint8_t best_ch = first->primary;
    float best_score = -1, best_rate = 0;

    for (int c = 0; c < n_ch; c++) {
        if (esp_wifi_set_channel(channels[c], WIFI_SECOND_CHAN_NONE) != ESP_OK) {
            ESP_LOGW(TAG, "channel %d not allowed, skipped", channels[c]);
            continue;
        }
        csi_capture_survey_start();
        vTaskDelay(pdMS_TO_TICKS(SURVEY_MS));
        int n = csi_capture_survey_stop(seen, SCAN_MAX);
        ESP_LOGI(TAG, "channel %d: %d transmitter(s) with CSI", channels[c], n);
        for (int i = 0; i < n; i++) {
            const wifi_ap_record_t *ap = find_ap(recs, n_ap, seen[i].mac);
            float rate = seen[i].frames * 1000.0f / SURVEY_MS;
            if (i < 5) {
                ESP_LOGI(TAG, "  " MACSTR " %5.1f Hz rssi %4d %s", MAC2STR(seen[i].mac), rate,
                         seen[i].rssi, ap ? (const char *)ap->ssid : "(client)");
            }
            bool good_ap = ap != NULL && ssid_wanted(ap) && rate >= GOOD_RATE_HZ;
            float score = rate + (good_ap ? 1000.0f : 0.0f);
            if (score > best_score) {
                best_score = score;
                best_rate = rate;
                best_ch = channels[c];
                memcpy(best_mac, seen[i].mac, 6);
            }
        }
    }

    const wifi_ap_record_t *best_ap = find_ap(recs, n_ap, best_mac);
    memcpy(s_bssid, best_mac, sizeof(s_bssid));
    s_channel = best_ch;
    strlcpy(s_ssid, best_ap ? (const char *)best_ap->ssid : "(client device)", sizeof(s_ssid));
    free(recs);
    free(seen);

    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_channel(s_channel, WIFI_SECOND_CHAN_NONE));
    csi_capture_set_target(s_bssid);
    ESP_LOGI(TAG, "sniffer mode: CSI from \"%s\" (" MACSTR ") on channel %d, %.0f Hz in the survey",
             s_ssid, MAC2STR(s_bssid), s_channel, best_rate);
    if (best_rate < GOOD_RATE_HZ) {
        ESP_LOGW(TAG, "little CSI traffic here; add Wi-Fi credentials in src/wifi_secrets.h "
                      "for ~100 Hz station mode");
    }
    return ESP_OK;
}

esp_err_t wifi_link_start(void)
{
    s_events = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_events != NULL, ESP_ERR_NO_MEM, TAG, "event group");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    s_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "wifi init");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL),
                        TAG, "wifi events");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL),
                        TAG, "ip events");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "storage");
    /* The default country "01" allows channels 1-11 only */
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_country_code(LIFEFI_COUNTRY, true));
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "mode");
    /* Before start: the STA_START handler connects immediately, and a 40 MHz
     * association would make every CSI frame unusable (cwb != 0) */
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));
    /* Power save makes the station sleep and the CSI rate collapse */
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_ps(WIFI_PS_NONE));

    bool have_ssid = LIFEFI_WIFI_SSID[0] != '\0';
    s_mode = have_ssid ? LINK_STATION : LINK_SNIFFER;
    if (have_ssid) {
        wifi_config_t wc = { 0 };
        strlcpy((char *)wc.sta.ssid, LIFEFI_WIFI_SSID, sizeof(wc.sta.ssid));
        strlcpy((char *)wc.sta.password, LIFEFI_WIFI_PASSWORD, sizeof(wc.sta.password));
        wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
        ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wc), TAG, "sta config");
    }

    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "wifi start");
    ESP_RETURN_ON_ERROR(csi_capture_start(), TAG, "csi");

    if (have_ssid) {
        ESP_LOGI(TAG, "station mode: connecting to \"%s\"", LIFEFI_WIFI_SSID);
        EventBits_t bits = xEventGroupWaitBits(s_events, BIT_GOT_IP, pdFALSE, pdTRUE,
                                               pdMS_TO_TICKS(LIFEFI_CONNECT_TIMEOUT_MS));
        if (bits & BIT_GOT_IP) {
            return ESP_OK;
        }
        ESP_LOGW(TAG, "could not connect to \"%s\" in %d s, falling back to sniffer mode",
                 LIFEFI_WIFI_SSID, LIFEFI_CONNECT_TIMEOUT_MS / 1000);
        s_give_up = true;
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(200));
    } else {
        ESP_LOGI(TAG, "no Wi-Fi credentials (src/wifi_secrets.h): sniffer mode");
    }
    return start_sniffer();
}

void wifi_link_describe(char *buf, size_t len)
{
    snprintf(buf, len, "%s \"%s\" " MACSTR " ch %d | ping timeouts %lu | disconnects %lu",
             s_mode == LINK_STATION ? "station" : "sniffer", s_ssid, MAC2STR(s_bssid),
             s_channel, (unsigned long)s_ping_timeouts, (unsigned long)s_disconnects);
}
