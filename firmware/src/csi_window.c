#include "csi_window.h"

#include <math.h>
#include <string.h>

static inline float sc_amp(const int8_t *b, int j)
{
    float im = b[2 * j];
    float re = b[2 * j + 1];
    return sqrtf(im * im + re * re);
}

void csi_lltf_amplitudes(const csi_packet_t *p, float out[LIFEFI_NSC])
{
    int o = 0;
    for (int j = 38; j < 64; j++) {   /* k = -26..-1 */
        out[o++] = sc_amp(p->lltf, j);
    }
    for (int j = 1; j <= 26; j++) {   /* k = +1..+26 */
        out[o++] = sc_amp(p->lltf, j);
    }
    if (p->first_word_invalid) {      /* bytes 0..3 (DC and k = +1) are garbage */
        out[26] = out[27];
    }
}

bool csi_window_add(csi_window_acc_t *acc, const csi_packet_t *p)
{
    float amp[LIFEFI_NSC];
    csi_lltf_amplitudes(p, amp);
    float mean = 0;
    for (int k = 0; k < LIFEFI_NSC; k++) {
        mean += amp[k];
    }
    mean /= LIFEFI_NSC;
    if (mean < 1.0f) {
        return false;
    }
    /* Per-packet normalisation cancels AGC and CSI auto-scaling */
    for (int k = 0; k < LIFEFI_NSC; k++) {
        float x = amp[k] / mean - 1.0f;
        acc->sum[k] += x;
        acc->sumsq[k] += x * x;
    }
    acc->n++;
    acc->rssi_sum += p->rssi;
    return true;
}

void csi_window_close(csi_window_acc_t *acc, int64_t span_us, csi_window_t *w)
{
    memset(w, 0, sizeof(*w));
    w->n = acc->n;
    w->rate_hz = span_us > 0 ? acc->n * 1e6f / (float)span_us : 0;
    if (acc->n > 0) {
        w->rssi = (float)acc->rssi_sum / acc->n;
        for (int k = 0; k < LIFEFI_NSC; k++) {
            float m = acc->sum[k] / acc->n;
            float v = acc->sumsq[k] / acc->n - m * m;
            w->mean[k] = 1.0f + m;
            w->var[k] = v > 0 ? v : 0;
        }
    }
    memset(acc, 0, sizeof(*acc));
}
