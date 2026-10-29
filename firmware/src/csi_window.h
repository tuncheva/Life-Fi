/* Pure CSI maths with no ESP-IDF dependencies, so it runs in the host
 * tests: LLTF buffer -> 52 amplitudes -> per-second window statistics. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "estimator.h"
#include "lifefi_config.h"

#define CSI_BUF_MAX 256       /* LLTF + HT-LTF, 20 MHz, no STBC */

typedef struct {
    int64_t ts_us;            /* esp_timer_get_time() at the callback */
    uint8_t mac[6];           /* transmitter */
    int8_t rssi;
    int8_t noise_floor;
    uint8_t sig_mode;         /* 0 non-HT, 1 HT */
    uint8_t mcs;
    uint8_t cwb;              /* 0 = 20 MHz */
    uint8_t stbc;
    uint8_t channel;
    uint8_t secondary_channel;
    bool first_word_invalid;
    uint16_t rx_seq;          /* 802.11 sequence number */
    uint16_t len;             /* valid bytes in buf */
    /* 64 x [imag, real] per LTF, subcarriers 0..31 then -32..-1:
     * bytes 0..127 LLTF, then 128..255 HT-LTF on HT frames */
    int8_t buf[CSI_BUF_MAX];
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
