/* Life-Fi firmware: Wi-Fi CSI -> 1 s feature windows -> presence and
 * people-count estimate on the serial console. */
#include <stdlib.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "commands.h"
#include "csi_capture.h"
#include "csi_window.h"
#include "estimator.h"
#include "lifefi_config.h"
#include "wifi_link.h"

static const char *TAG = "main";

#define HEALTH_EVERY_WINDOWS 15

static void log_health(void)
{
    char link[128];
    csi_counters_t c;
    wifi_link_describe(link, sizeof(link));
    csi_capture_counters(&c);
    ESP_LOGI(TAG, "wifi %s | csi %lu, other tx %lu, rejected %lu, queue drops %lu | heap %lu",
             link, (unsigned long)c.received, (unsigned long)c.other_mac,
             (unsigned long)c.rejected, (unsigned long)c.queue_drops,
             (unsigned long)esp_get_free_heap_size());
}

static void csi_task(void *arg)
{
    QueueHandle_t q = csi_capture_queue();
    csi_window_acc_t *acc = calloc(1, sizeof(*acc));
    csi_window_t *w = calloc(1, sizeof(*w));
    if (acc == NULL || w == NULL) {
        ESP_LOGE(TAG, "out of memory");
        vTaskDelete(NULL);
        return;
    }

    csi_packet_t p;
    int64_t win_start = esp_timer_get_time();
    uint32_t windows = 0;

    for (;;) {
        if (xQueueReceive(q, &p, pdMS_TO_TICKS(50)) == pdTRUE) {
            csi_window_add(acc, &p);
        }

        int64_t now = esp_timer_get_time();
        if (now - win_start >= LIFEFI_WINDOW_MS * 1000LL) {
            csi_window_close(acc, now - win_start, w);
            win_start = now;
            estimator_push(w);
            if (++windows % HEALTH_EVERY_WINDOWS == 0) {
                log_health();
            }
        }
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_LOGI(TAG, "Life-Fi CSI people counter v%s", LIFEFI_FW_VERSION);
    estimator_init();
    commands_start();
    ESP_ERROR_CHECK(wifi_link_start());
    xTaskCreate(csi_task, "csi", 4096, NULL, 5, NULL);
}
