/* Pure CSI maths with no ESP-IDF dependencies, so it runs in the host
 * tests: LLTF buffer -> 52 amplitudes -> per-second window statistics. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "estimator.h"
#include "lifefi_config.h"

typedef struct {
    int64_t ts_us;            /* esp_timer_get_time() at the callback */
    int8_t rssi;
    uint8_t sig_mode;         /* 0 non-HT, 1 HT */
    bool first_word_invalid;
    int8_t lltf[128];         /* 64 x [imag, real], subcarriers 0..31 then -32..-1 */
} csi_packet_t;

/* Sums of (normalised amplitude - 1): the offset keeps float variance exact */
typedef struct {
    uint32_t n;
    int32_t rssi_sum;
    float sum[LIFEFI_NSC];
    float sumsq[LIFEFI_NSC];
} csi_window_acc_t;

/* LLTF -> 52 amplitudes, ordered k = -26..-1, +1..+26 */
void csi_lltf_amplitudes(const csi_packet_t *p, float out[LIFEFI_NSC]);

/* Normalise one packet by its mean amplitude and add it to the window.
 * Returns false (packet skipped) when the buffer is empty or broken. */
bool csi_window_add(csi_window_acc_t *acc, const csi_packet_t *p);

/* Turn the sums into per-subcarrier mean and variance, then reset acc. */
void csi_window_close(csi_window_acc_t *acc, int64_t span_us, csi_window_t *w);
