/* Host stub: warnings and errors always print, info lines only when verbose */
#pragma once

#include <stdio.h>

extern int host_log_verbose;

#define ESP_LOGE(tag, fmt, ...) printf("E %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) printf("W %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...)                                   \
    do {                                                          \
        if (host_log_verbose) {                                   \
            printf("I %s: " fmt "\n", tag, ##__VA_ARGS__);        \
        }                                                         \
    } while (0)
