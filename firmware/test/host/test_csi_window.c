/* csi_window.c: LLTF buffer layout, first_word_invalid repair, per-packet
 * normalisation (gain invariance) and window statistics. */
#include <math.h>
#include <string.h>
#include "csi_window.h"
#include "host_test.h"

/* Write subcarrier k (-32..31) the way the ESP32 does: [imag, real] at j = k mod 64 */
static void set_sc(csi_packet_t *p, int k, int re, int im)
{
    int j = k >= 0 ? k : k + 64;
    p->buf[2 * j] = (int8_t)im;
    p->buf[2 * j + 1] = (int8_t)re;
}

/* Subcarrier number of output column i: -26..-1, +1..+26 */
static int col_k(int i)
{
    return i < 26 ? i - 26 : i - 25;
}

static void test_layout(void)
{
    printf("== LLTF layout\n");
    csi_packet_t p;
    memset(&p, 0, sizeof(p));
    for (int k = -32; k < 32; k++) {
        bool kept = k != 0 && k >= -26 && k <= 26;
        if (kept) {
            set_sc(&p, k, k + 40, 0);      /* amplitude encodes k */
        } else {
            set_sc(&p, k, 127, 127);       /* DC and guards: must never be read */
        }
    }
    float a[LIFEFI_NSC];
    csi_lltf_amplitudes(&p, a);
    int wrong = 0;
    for (int i = 0; i < LIFEFI_NSC; i++) {
        wrong += fabsf(a[i] - (float)(col_k(i) + 40)) > 1e-4f;
    }
    CHECK(wrong == 0, "52 columns map to k = -26..-1, +1..+26 (%d wrong)", wrong);
    CHECK(fabsf(a[0] - 14) < 1e-4f && fabsf(a[25] - 39) < 1e-4f, "column 0 is k=-26, column 25 is k=-1");
    CHECK(fabsf(a[26] - 41) < 1e-4f && fabsf(a[51] - 66) < 1e-4f, "column 26 is k=+1, column 51 is k=+26");

    memset(&p, 0, sizeof(p));
    set_sc(&p, 5, 3, 4);
    csi_lltf_amplitudes(&p, a);
    CHECK(fabsf(a[30] - 5.0f) < 1e-4f, "amplitude is sqrt(re^2 + im^2) (3,4 -> 5 at k=+5)");
}

static void test_first_word_invalid(void)
{
    printf("== first_word_invalid\n");
    csi_packet_t p;
    memset(&p, 0, sizeof(p));
    set_sc(&p, 1, 120, 120);   /* garbage on k = +1 */
    set_sc(&p, 2, 30, 0);
    float a[LIFEFI_NSC];
    p.first_word_invalid = true;
    csi_lltf_amplitudes(&p, a);
    CHECK(fabsf(a[26] - 30) < 1e-4f, "k=+1 replaced by k=+2 when flagged (got %.1f)", a[26]);
    p.first_word_invalid = false;
    csi_lltf_amplitudes(&p, a);
    CHECK(a[26] > 160, "k=+1 kept when not flagged (got %.1f)", a[26]);
}

/* A frequency-selective channel: amplitude 15..65 across subcarriers */
static void fill_channel(csi_packet_t *p, float gain)
{
    memset(p, 0, sizeof(*p));
    for (int k = -26; k <= 26; k++) {
        if (k == 0) {
            continue;
        }
        float amp = 40.0f + 25.0f * sinf(k * 0.37f);
        float ph = k * 0.8f;
        set_sc(p, k, (int)lrintf(gain * amp * cosf(ph)), (int)lrintf(gain * amp * sinf(ph)));
    }
}

static void test_gain_invariance(void)
{
    printf("== per-packet normalisation\n");
    csi_window_acc_t acc;
    memset(&acc, 0, sizeof(acc));
    csi_packet_t lo, hi;
    fill_channel(&lo, 1.0f);
    fill_channel(&hi, 1.9f);   /* an AGC jump of +5.6 dB */
    for (int i = 0; i < 100; i++) {
        csi_window_add(&acc, i % 2 ? &hi : &lo);
    }
    csi_window_t w;
    csi_window_close(&acc, 1000000, &w);
    float max_var = 0;
    for (int k = 0; k < LIFEFI_NSC; k++) {
        max_var = fmaxf(max_var, w.var[k]);
    }
    /* int8 rounding leaves ~1e-4; a real 1.9x gain step un-normalised would be ~0.2 */
    CHECK(max_var < 5e-4f, "alternating 1x / 1.9x gain gives no variance (max %.2e)", max_var);

    float mean_of_means = 0;
    for (int k = 0; k < LIFEFI_NSC; k++) {
        mean_of_means += w.mean[k];
    }
    mean_of_means /= LIFEFI_NSC;
    CHECK(fabsf(mean_of_means - 1.0f) < 1e-3f, "normalised profile averages 1.0 (%.4f)", mean_of_means);
}

static void test_statistics(void)
{
    printf("== window statistics\n");
    csi_packet_t flat, split;
    memset(&flat, 0, sizeof(flat));
    memset(&split, 0, sizeof(split));
    for (int i = 0; i < LIFEFI_NSC; i++) {
        int k = col_k(i);
        set_sc(&flat, k, 40, 0);
        set_sc(&split, k, i < 26 ? 30 : 50, 0);   /* same mean, so normalised 0.75 / 1.25 */
    }
    csi_window_acc_t acc;
    memset(&acc, 0, sizeof(acc));
    for (int i = 0; i < 50; i++) {
        flat.rssi = -40;
        split.rssi = -60;
        csi_window_add(&acc, &flat);
        csi_window_add(&acc, &split);
    }
    csi_window_t w;
    csi_window_close(&acc, 500000, &w);
    CHECK(w.n == 100, "100 packets counted (%u)", (unsigned)w.n);
    CHECK(fabsf(w.rate_hz - 200.0f) < 0.01f, "rate = packets / span (%.1f Hz)", w.rate_hz);
    CHECK(fabsf(w.rssi + 50.0f) < 0.01f, "rssi averaged (%.1f)", w.rssi);
    CHECK(fabsf(w.mean[0] - 0.875f) < 1e-4f && fabsf(w.mean[51] - 1.125f) < 1e-4f,
          "per-subcarrier mean (%.4f, %.4f)", w.mean[0], w.mean[51]);
    CHECK(fabsf(w.var[0] - 0.015625f) < 1e-5f && fabsf(w.var[51] - 0.015625f) < 1e-5f,
          "per-subcarrier variance 0.125^2 (%.6f, %.6f)", w.var[0], w.var[51]);
    CHECK(acc.n == 0 && acc.sum[0] == 0 && acc.sumsq[51] == 0, "accumulator reset after close");
}

static void test_rejects(void)
{
    printf("== broken packets\n");
    csi_window_acc_t acc;
    memset(&acc, 0, sizeof(acc));
    csi_packet_t zero;
    memset(&zero, 0, sizeof(zero));
    CHECK(!csi_window_add(&acc, &zero) && acc.n == 0, "all-zero buffer skipped");
    csi_window_t w;
    csi_window_close(&acc, 1000000, &w);
    CHECK(w.n == 0 && w.rate_hz == 0 && w.var[10] == 0, "empty window closes to zeros");
    csi_window_close(&acc, 0, &w);
    CHECK(w.rate_hz == 0, "zero-length span does not divide by zero");
}

int main(int argc, char **argv)
{
    host_init(argc, argv, 1);
    test_layout();
    test_first_word_invalid();
    test_gain_invariance();
    test_statistics();
    test_rejects();
    return host_finish("test_csi_window");
}
