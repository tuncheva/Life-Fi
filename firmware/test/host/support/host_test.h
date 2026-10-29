/* Shared helpers for the host tests: fake clock, in-memory NVS, a
 * deterministic RNG and a CHECK macro that counts failures. */
#pragma once

#include <stdint.h>
#include <stdio.h>

extern int host_log_verbose;     /* print ESP_LOGI lines too */
extern int64_t host_now_us;      /* what esp_timer_get_time() returns */
extern int host_failures;
extern int host_nvs_writes;      /* successful nvs_set_blob calls */

#define CHECK(cond, ...)                 \
    do {                                 \
        if (cond) {                      \
            printf("  ok   ");           \
        } else {                         \
            printf("  FAIL ");           \
            host_failures++;             \
        }                                \
        printf(__VA_ARGS__);             \
        printf("\n");                    \
    } while (0)

void host_init(int argc, char **argv, uint32_t seed);   /* -v turns on ESP_LOGI */
float host_frand(void);                                 /* uniform [0, 1) */
float host_gauss(void);                                 /* ~N(0, 1) */
void host_nvs_clear(void);
int host_finish(const char *name);                      /* summary; returns exit code */
