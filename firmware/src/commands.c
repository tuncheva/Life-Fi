#include "commands.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "estimator.h"
#include "lifefi_config.h"

#if CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#endif

static const char *TAG = "cmd";

static void print_help(void)
{
    ESP_LOGI(TAG, "commands: cal | learn N (1-%d) | forget | status | help", LIFEFI_MAX_COUNT);
}

void commands_handle_line(char *line)
{
    while (isspace((unsigned char)*line)) {
        line++;
    }
    for (char *p = line; *p; p++) {
        *p = (char)tolower((unsigned char)*p);
    }
    size_t len = strlen(line);
    while (len > 0 && isspace((unsigned char)line[len - 1])) {
        line[--len] = '\0';
    }
    if (len == 0) {
        return;
    }

    if (strcmp(line, "help") == 0 || strcmp(line, "?") == 0) {
        print_help();
    } else if (strcmp(line, "cal") == 0) {
        estimator_request_calibration();
    } else if (strncmp(line, "learn", 5) == 0) {
        int n = atoi(line + 5);
        if (n < 1 || n > LIFEFI_MAX_COUNT) {
            ESP_LOGW(TAG, "usage: learn N with N = 1..%d (0 is the empty calibration, `cal`)",
                     LIFEFI_MAX_COUNT);
        } else {
            estimator_request_learn(n);
        }
    } else if (strcmp(line, "forget") == 0) {
        estimator_request_forget();
    } else if (strcmp(line, "status") == 0) {
        estimator_request_status();
    } else {
        ESP_LOGW(TAG, "unknown command \"%s\"", line);
        print_help();
    }
}

#if CONFIG_ESP_CONSOLE_UART
static void cmd_task(void *arg)
{
    char line[64];
    size_t len = 0;
    uint8_t ch;
    for (;;) {
        if (uart_read_bytes(CONFIG_ESP_CONSOLE_UART_NUM, &ch, 1, portMAX_DELAY) <= 0) {
            continue;
        }
        if (ch == '\r' || ch == '\n') {
            line[len] = '\0';
            commands_handle_line(line);
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

void commands_start(void)
{
#if CONFIG_ESP_CONSOLE_UART
    esp_err_t err = uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 256, 0, 0, NULL, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "serial commands disabled: %s", esp_err_to_name(err));
        return;
    }
    xTaskCreate(cmd_task, "cmd", 3072, NULL, 3, NULL);
    print_help();
#else
    ESP_LOGW(TAG, "console is not on a UART; serial commands are disabled");
#endif
}
