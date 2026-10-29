/* Host implementations of the ESP-IDF calls used by the tested modules. */
#include <string.h>
#include "esp_err.h"
#include "esp_timer.h"
#include "host_test.h"
#include "nvs.h"

int host_log_verbose;
int64_t host_now_us;
int host_failures;
int host_nvs_writes;

static uint32_t s_rng = 1;

void host_init(int argc, char **argv, uint32_t seed)
{
    host_log_verbose = argc > 1 && strcmp(argv[1], "-v") == 0;
    host_now_us = 0;
    host_failures = 0;
    s_rng = seed ? seed : 1;
    host_nvs_clear();
}

float host_frand(void)
{
    s_rng = s_rng * 1664525u + 1013904223u;
    return (s_rng >> 8) / 16777216.0f;
}

float host_gauss(void)
{
    /* Irwin-Hall with 4 terms, scaled to unit variance */
    return (host_frand() + host_frand() + host_frand() + host_frand() - 2.0f) * 1.7320508f;
}

int host_finish(const char *name)
{
    printf("\n%s %s: %d failure(s)\n", name, host_failures ? "FAILED" : "PASSED", host_failures);
    return host_failures ? 1 : 0;
}

/* ---- esp_timer / esp_err ------------------------------------------------- */

int64_t esp_timer_get_time(void)
{
    return host_now_us;
}

const char *esp_err_to_name(esp_err_t err)
{
    return err == ESP_OK ? "ESP_OK" : "ESP_FAIL";
}

/* ---- nvs: a single in-memory blob ---------------------------------------- */

static unsigned char s_blob[1024];
static size_t s_blob_len;

void host_nvs_clear(void)
{
    s_blob_len = 0;
    host_nvs_writes = 0;
}

esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out)
{
    *out = 1;
    return ESP_OK;
}

esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len)
{
    if (s_blob_len == 0) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    if (*len < s_blob_len) {
        return ESP_FAIL;
    }
    memcpy(out, s_blob, s_blob_len);
    *len = s_blob_len;
    return ESP_OK;
}

esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *value, size_t len)
{
    if (len > sizeof(s_blob)) {
        return ESP_FAIL;
    }
    memcpy(s_blob, value, len);
    s_blob_len = len;
    host_nvs_writes++;
    return ESP_OK;
}

esp_err_t nvs_commit(nvs_handle_t h)
{
    return ESP_OK;
}

void nvs_close(nvs_handle_t h)
{
}
