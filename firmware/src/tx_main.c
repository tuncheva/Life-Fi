/* Life-Fi fixed transmitter (envs *_tx, -DLIFEFI_ROLE_TX=1): ESP-NOW
 * broadcasts at a steady rate on a fixed channel, at HT20 MCS0, from the
 * fixed MAC 1A:4C:46:54:58:<id>. The receiver locks onto that MAC and takes
 * one CSI sample from every frame. Same idea as Espressif's esp-csi
 * csi_send. ESP-NOW's default rate is 1 Mbps 802.11b, which carries no CSI:
 * the rate call below is the important part.
 *
 * Serial commands (921600 baud): status | channel <1-13> | rate <10-500> | help.
 * Settings are saved in flash (NVS namespace "lifefi_tx") and applied live.
 * See docs/hardware/fixed-transmitter.md. */
#include "lifefi_config.h"

#if LIFEFI_ROLE_TX

#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#if CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#endif

static const char *TAG = "tx";

#define NVS_NS        "lifefi_tx"
#define NVS_KEY_CH    "channel"
#define NVS_KEY_RATE  "rate"
#define RATE_MIN      10
#define RATE_MAX      500
#define STATUS_EVERY_US 10000000LL
#define CMD_LINE_MAX  64

/* Frame payload. Not read by the receiver yet; seq allows a loss counter later. */
typedef struct __attribute__((packed)) {
    char magic[4];      /* "LFTX" */
    uint8_t version;    /* 1 */
    uint8_t id;
    uint16_t rate_hz;
    uint32_t seq;
} tx_payload_t;

static const uint8_t BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

static uint8_t s_channel = LIFEFI_TX_CHANNEL;
static volatile uint16_t s_rate = LIFEFI_TX_RATE_HZ;
static volatile uint32_t s_sent, s_send_ok, s_send_failed;
static uint32_t s_last_sent;
static int64_t s_last_status_us;

/* ---- settings ----------------------------------------------------------- */

static void load_settings(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    uint8_t ch;
    uint16_t rate;
    if (nvs_get_u8(h, NVS_KEY_CH, &ch) == ESP_OK && ch >= 1 && ch <= 13) {
        s_channel = ch;
    }
    if (nvs_get_u16(h, NVS_KEY_RATE, &rate) == ESP_OK && rate >= RATE_MIN && rate <= RATE_MAX) {
        s_rate = rate;
    }
    nvs_close(h);
}

static void save_settings(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        err = nvs_set_u8(h, NVS_KEY_CH, s_channel);
        if (err == ESP_OK) {
            err = nvs_set_u16(h, NVS_KEY_RATE, s_rate);
        }
        if (err == ESP_OK) {
            err = nvs_commit(h);
        }
        nvs_close(h);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "could not save the settings: %s", esp_err_to_name(err));
    }
}

/* ---- LED: 1 Hz blink = sending, off = not sending, 5 Hz = init failed --- */

static void led_init(void)
{
#if LIFEFI_TX_LED_GPIO >= 0
    gpio_reset_pin(LIFEFI_TX_LED_GPIO);
    gpio_set_direction(LIFEFI_TX_LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(LIFEFI_TX_LED_GPIO, LIFEFI_TX_LED_ACTIVE_LOW ? 1 : 0);
#endif
}

static void led_set(bool on)
{
#if LIFEFI_TX_LED_GPIO >= 0
    gpio_set_level(LIFEFI_TX_LED_GPIO, on != (bool)LIFEFI_TX_LED_ACTIVE_LOW);
#endif
}

static void fail_blink_forever(void)
{
    bool on = false;
    for (;;) {
        led_set(on = !on);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

/* ---- sending ------------------------------------------------------------ */

static void on_sent(const esp_now_send_info_t *tx_info, esp_now_send_status_t status)
{
    if (status == ESP_NOW_SEND_SUCCESS) {
        s_send_ok++;
    } else {
        s_send_failed++;
    }
}

static void log_status(void)
{
    int64_t now = esp_timer_get_time();
    uint32_t sent = s_sent;
    float hz = s_last_status_us > 0 ? (sent - s_last_sent) * 1e6f / (float)(now - s_last_status_us)
                                    : 0.0f;
    ESP_LOGI(TAG, "sent %lu (+%lu), failed %lu, %.0f Hz (set %u), ch %u, heap %lu",
             (unsigned long)sent, (unsigned long)(sent - s_last_sent),
             (unsigned long)s_send_failed, hz, (unsigned)s_rate, (unsigned)s_channel,
             (unsigned long)esp_get_free_heap_size());
    s_last_sent = sent;
    s_last_status_us = now;
}

/* 1 ms tick (sdkconfig.defaults): rates that do not divide 1000 are rounded;
 * the status line shows the measured rate */
static void send_task(void *arg)
{
    tx_payload_t p = { .magic = { 'L', 'F', 'T', 'X' }, .version = 1, .id = LIFEFI_TX_ID };
    TickType_t last = xTaskGetTickCount();
    s_last_status_us = esp_timer_get_time();
    uint32_t since_toggle = 0;
    bool led = false;
    for (;;) {
        uint16_t rate = s_rate;
        TickType_t period = pdMS_TO_TICKS((1000 + rate / 2) / rate);
        xTaskDelayUntil(&last, period > 0 ? period : 1);

        p.rate_hz = rate;
        p.seq = s_sent;
        if (esp_now_send(BROADCAST, (const uint8_t *)&p, sizeof(p)) == ESP_OK) {
            s_sent++;
            if (++since_toggle >= rate) {
                led_set(led = !led);
                since_toggle = 0;
            }
        } else {
            s_send_failed++;
        }
        if (esp_timer_get_time() - s_last_status_us >= STATUS_EVERY_US) {
            log_status();
        }
    }
}

/* ---- Wi-Fi + ESP-NOW ---------------------------------------------------- */

/* Returns the name of the rate API that worked, or NULL */
static const char *set_ht_rate(void)
{
    esp_now_rate_config_t rc = {
        .phymode = WIFI_PHY_MODE_HT20,
        .rate = WIFI_PHY_RATE_MCS0_LGI,
        .ersu = false,
        .dcm = false,
    };
    esp_err_t err = esp_now_set_peer_rate_config(BROADCAST, &rc);
    if (err == ESP_OK) {
        return "esp_now_set_peer_rate_config";
    }
    ESP_LOGW(TAG, "esp_now_set_peer_rate_config: %s, trying the older call", esp_err_to_name(err));
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    err = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI);
#pragma GCC diagnostic pop
    if (err == ESP_OK) {
        return "esp_wifi_config_espnow_rate";
    }
    ESP_LOGE(TAG, "esp_wifi_config_espnow_rate: %s", esp_err_to_name(err));
    return NULL;
}

static esp_err_t radio_start(const char **rate_api)
{
    esp_err_t err;
#define TRY(call)                                                                  \
    do {                                                                           \
        if ((err = (call)) != ESP_OK) {                                            \
            ESP_LOGE(TAG, "%s failed: %s", #call, esp_err_to_name(err));           \
            return err;                                                            \
        }                                                                          \
    } while (0)

    TRY(esp_netif_init());
    TRY(esp_event_loop_create_default());
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    TRY(esp_wifi_init(&init));
    TRY(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    /* The default country "01" allows channels 1-11 only */
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_country_code(LIFEFI_COUNTRY, true));
    TRY(esp_wifi_set_mode(WIFI_MODE_STA));
    /* The receiver drops 40 MHz frames (cwb != 0) */
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));
    /* Only while the interface is stopped. On failure keep the factory MAC:
     * the start line then shows it, and the receiver will not lock onto it */
    uint8_t mac[6] = LIFEFI_TX_MAC_PREFIX;
    mac[5] = LIFEFI_TX_ID;
    err = esp_wifi_set_mac(WIFI_IF_STA, mac);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_mac: %s; the receiver will NOT recognise this transmitter",
                 esp_err_to_name(err));
    }
    TRY(esp_wifi_start());
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_ps(WIFI_PS_NONE));
    TRY(esp_wifi_set_channel(s_channel, WIFI_SECOND_CHAN_NONE));

    TRY(esp_now_init());
    TRY(esp_now_register_send_cb(on_sent));
    esp_now_peer_info_t peer = { .channel = 0, .ifidx = WIFI_IF_STA, .encrypt = false };
    memcpy(peer.peer_addr, BROADCAST, sizeof(BROADCAST));
    TRY(esp_now_add_peer(&peer));
    *rate_api = set_ht_rate();
    if (*rate_api == NULL) {
        return ESP_FAIL;   /* 802.11b frames would carry no CSI */
    }
#undef TRY
    return ESP_OK;
}

/* ---- serial commands ---------------------------------------------------- */

static void print_help(void)
{
    ESP_LOGI(TAG, "commands: status | channel <1-13> | rate <%d-%d> | help", RATE_MIN, RATE_MAX);
}

static void handle_line(char *line)
{
    for (char *p = line; *p; p++) {
        *p = (char)tolower((unsigned char)*p);
    }
    char *cmd = strtok(line, " \t");
    char *arg = strtok(NULL, " \t");
    if (cmd == NULL) {
        return;
    }
    if (strcmp(cmd, "status") == 0) {
        log_status();
    } else if (strcmp(cmd, "channel") == 0 && arg != NULL) {
        int ch = atoi(arg);
        if (ch < 1 || ch > 13 || esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
            ESP_LOGW(TAG, "channel must be 1-13");
            return;
        }
        s_channel = (uint8_t)ch;
        save_settings();
        ESP_LOGW(TAG, "now on channel %d (saved); reset the receiver so it finds it", ch);
    } else if (strcmp(cmd, "rate") == 0 && arg != NULL) {
        int rate = atoi(arg);
        if (rate < RATE_MIN || rate > RATE_MAX) {
            ESP_LOGW(TAG, "rate must be %d-%d", RATE_MIN, RATE_MAX);
            return;
        }
        s_rate = (uint16_t)rate;
        save_settings();
        ESP_LOGW(TAG, "now sending at %d Hz (saved)", rate);
    } else {
        print_help();
    }
}

#if CONFIG_ESP_CONSOLE_UART
static void cmd_task(void *arg)
{
    char line[CMD_LINE_MAX];
    size_t len = 0;
    uint8_t ch;
    for (;;) {
        if (uart_read_bytes(CONFIG_ESP_CONSOLE_UART_NUM, &ch, 1, portMAX_DELAY) <= 0) {
            continue;
        }
        if (ch == '\r' || ch == '\n') {
            line[len] = '\0';
            handle_line(line);
            len = 0;
        } else if (ch == 8 || ch == 127) {
            if (len > 0) {
                len--;
            }
        } else if (len < sizeof(line) - 1) {
            line[len++] = (char)ch;
        }
    }
}
#endif

static void commands_start(void)
{
#if CONFIG_ESP_CONSOLE_UART
    if (uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 256, 2048, 0, NULL, 0) != ESP_OK) {
        ESP_LOGW(TAG, "serial commands disabled");
        return;
    }
    uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
    xTaskCreate(cmd_task, "cmd", 3072, NULL, 3, NULL);
    print_help();
#endif
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    load_settings();
    led_init();
    commands_start();

    const char *rate_api = NULL;
    if (radio_start(&rate_api) != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi / ESP-NOW start failed, NOT sending (LED blinks fast)");
        fail_blink_forever();
    }
    uint8_t mac[6] = { 0 };
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    ESP_LOGI(TAG, "Life-Fi fixed transmitter v%s: ESP-NOW %u Hz on channel %u as " MACSTR
                  ", HT20 MCS0 (via %s)",
             LIFEFI_FW_VERSION, (unsigned)s_rate, (unsigned)s_channel, MAC2STR(mac), rate_api);
    xTaskCreate(send_task, "tx", 3072, NULL, 5, NULL);
}

#endif /* LIFEFI_ROLE_TX */
