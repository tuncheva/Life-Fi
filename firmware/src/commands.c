#include "commands.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "estimator.h"
#include "lifefi_config.h"
#include "wifi_link.h"

#if CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#endif

static const char *TAG = "cmd";

#define CMD_LINE_MAX 128   /* fits wifi "<32-char ssid>" <63-char password> */

static void print_help(void)
{
    ESP_LOGI(TAG, "commands: cal | learn N (1-%d) | forget | status | wifi <ssid> <password> | "
                  "wifi clear | help", LIFEFI_MAX_COUNT);
}

static void wifi_usage(void)
{
    ESP_LOGW(TAG, "usage: wifi <ssid> <password>  |  wifi \"ssid with spaces\" <password>  |  "
                  "wifi clear");
}

/* wifi <ssid> <password>: the password is the rest of the line, so it may
 * contain spaces. Saved to flash, then the board restarts in station mode. */
static void cmd_wifi(char *args)
{
    if (*args == '\0') {
        wifi_usage();
        return;
    }
    char *ssid = args;
    char *rest;
    bool quoted = *args == '"';
    if (quoted) {
        ssid = args + 1;
        char *end = strchr(ssid, '"');
        if (end == NULL) {
            wifi_usage();
            return;
        }
        *end = '\0';
        rest = end + 1;
    } else {
        rest = args + strcspn(args, " \t");
        if (*rest != '\0') {
            *rest++ = '\0';
        }
    }
    while (isspace((unsigned char)*rest)) {
        rest++;
    }

    if (!quoted && strcmp(ssid, "clear") == 0 && *rest == '\0') {
        if (wifi_link_save_credentials(NULL, NULL) == ESP_OK) {
            ESP_LOGW(TAG, "Wi-Fi credentials cleared, restarting in sniffer mode");
            esp_restart();
        } else {
            ESP_LOGE(TAG, "could not clear the Wi-Fi credentials");
        }
        return;
    }
    size_t ssid_len = strlen(ssid);
    size_t pass_len = strlen(rest);
    if (ssid_len == 0 || ssid_len > 32 || pass_len > 64) {
        ESP_LOGW(TAG, "SSID must be 1-32 characters and the password at most 64");
        return;
    }
    if (pass_len > 0 && pass_len < 8) {
        ESP_LOGW(TAG, "WPA2 passwords are 8-63 characters; leave it out for an open network");
        return;
    }
    if (wifi_link_save_credentials(ssid, rest) != ESP_OK) {
        ESP_LOGE(TAG, "could not save the Wi-Fi credentials");
        return;
    }
    ESP_LOGW(TAG, "saved Wi-Fi \"%s\" (password: %u characters), restarting in station mode",
             ssid, (unsigned)pass_len);
    esp_restart();
}

void commands_handle_line(char *line)
{
    while (isspace((unsigned char)*line)) {
        line++;
    }
    size_t len = strlen(line);
    while (len > 0 && isspace((unsigned char)line[len - 1])) {
        line[--len] = '\0';
    }
    if (len == 0) {
        return;
    }
    /* Only the command word is case-insensitive: SSIDs and passwords are not */
    char *args = line + strcspn(line, " \t");
    if (*args != '\0') {
        *args++ = '\0';
        while (isspace((unsigned char)*args)) {
            args++;
        }
    }
    for (char *p = line; *p; p++) {
        *p = (char)tolower((unsigned char)*p);
    }

    if (strcmp(line, "help") == 0 || strcmp(line, "?") == 0) {
        print_help();
    } else if (strcmp(line, "cal") == 0) {
        estimator_request_calibration();
    } else if (strcmp(line, "learn") == 0) {
        int n = atoi(args);
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
    } else if (strcmp(line, "wifi") == 0) {
        cmd_wifi(args);
    } else {
        ESP_LOGW(TAG, "unknown command \"%s\"", line);
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
