#include "estimator.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"

static const char *TAG = "lifefi";

#define NVS_NS             "lifefi"
#define NVS_KEY_LEVELS     "levels"
#define LEVELS_VERSION     1
#define CAL_GRACE_WINDOWS  10   /* time to leave the room after typing `cal` */
#define STILL_ENTRY_WINDOWS 5   /* profile changed this long -> someone came in and stood still */

typedef enum { ST_CALIBRATING, ST_EMPTY, ST_PRESENT, ST_UNCERTAIN } state_t;

static const char *const STATE_NAMES[] = { "CALIBRATING", "EMPTY", "PRESENT", "UNCERTAIN" };

/* Feature centroid recorded with `learn N` for one known head count */
typedef struct {
    float log_motion;
    float active;
    uint16_t windows;
} level_t;

typedef struct {
    uint8_t version;
    level_t level[LIFEFI_MAX_COUNT + 1];   /* index = head count; 0 unused */
} levels_blob_t;

static struct {
    state_t state;
    int warmup_left;

    /* calibration */
    int cal_n;
    float cal_mean[LIFEFI_CALIB_WINDOWS][LIFEFI_NSC];
    float cal_var[LIFEFI_CALIB_WINDOWS][LIFEFI_NSC];
    float base_mean[LIFEFI_NSC];
    float base_var[LIFEFI_NSC];
    float motion_on, active_on, dev_on, dev_off;

    /* presence */
    float dev_smooth;             /* < 0 until the first window */
    uint8_t moving_recent;        /* bit i: the window i seconds ago was moving */
    int still_windows;
    int64_t last_motion_us;

    /* count */
    float hist_log_motion[LIFEFI_SMOOTH_WINDOWS];
    float hist_active[LIFEFI_SMOOTH_WINDOWS];
    int hist_n, hist_i;
    int raw_counts[LIFEFI_COUNT_MEDIAN];
    int raw_n, raw_i;
    int count;                    /* -1 = unknown */
    estimator_features_t last;

    /* learning */
    int learn_target;             /* -1 = not learning */
    int learn_n;
    double learn_log_motion, learn_active;
    levels_blob_t levels;
} s;

static volatile bool s_req_cal, s_req_forget, s_req_status;
static volatile int s_req_learn = -1;

/* ---- helpers ------------------------------------------------------------ */

static int cmp_float(const void *a, const void *b)
{
    float x = *(const float *)a;
    float y = *(const float *)b;
    return (x > y) - (x < y);
}

/* p-quantile of v[0..n-1]; sorts v in place */
static float quantile(float *v, int n, float p)
{
    qsort(v, n, sizeof(float), cmp_float);
    return v[(int)(p * (n - 1) + 0.5f)];
}

static float pearson(const float *a, const float *b, int n)
{
    double ma = 0, mb = 0;
    for (int i = 0; i < n; i++) {
        ma += a[i];
        mb += b[i];
    }
    ma /= n;
    mb /= n;
    double sab = 0, saa = 0, sbb = 0;
    for (int i = 0; i < n; i++) {
        double da = a[i] - ma;
        double db = b[i] - mb;
        sab += da * db;
        saa += da * da;
        sbb += db * db;
    }
    if (saa <= 0 || sbb <= 0) {
        return 1.0f;
    }
    return (float)(sab / sqrt(saa * sbb));
}

static int median_int(const int *v, int n)
{
    int t[LIFEFI_COUNT_MEDIAN];
    memcpy(t, v, n * sizeof(int));
    for (int i = 1; i < n; i++) {
        for (int j = i; j > 0 && t[j - 1] > t[j]; j--) {
            int x = t[j];
            t[j] = t[j - 1];
            t[j - 1] = x;
        }
    }
    return t[n / 2];
}

static void fmt_count(char *buf, size_t len, int count)
{
    if (count < 0) {
        snprintf(buf, len, "?");
    } else if (count >= LIFEFI_MAX_COUNT) {
        snprintf(buf, len, "%d+", LIFEFI_MAX_COUNT);
    } else {
        snprintf(buf, len, "%d", count);
    }
}

static void window_features(const float *mean, const float *var,
                            float *motion, float *active, float *dev)
{
    float m = 0;
    int act = 0;
    for (int k = 0; k < LIFEFI_NSC; k++) {
        float r = var[k] / s.base_var[k];
        m += sqrtf(r);
        if (r > LIFEFI_ACTIVE_K) {
            act++;
        }
    }
    *motion = m / LIFEFI_NSC;
    *active = (float)act / LIFEFI_NSC;
    *dev = 1.0f - pearson(mean, s.base_mean, LIFEFI_NSC);
}

/* ---- learned levels ----------------------------------------------------- */

static void levels_load(void)
{
    memset(&s.levels, 0, sizeof(s.levels));
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    levels_blob_t blob;
    size_t len = sizeof(blob);
    if (nvs_get_blob(h, NVS_KEY_LEVELS, &blob, &len) == ESP_OK && len == sizeof(blob) &&
        blob.version == LEVELS_VERSION) {
        s.levels = blob;
    }
    nvs_close(h);
}

static void levels_save(void)
{
    s.levels.version = LEVELS_VERSION;
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        err = nvs_set_blob(h, NVS_KEY_LEVELS, &s.levels, sizeof(s.levels));
        if (err == ESP_OK) {
            err = nvs_commit(h);
        }
        nvs_close(h);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "saving learned levels failed: %s", esp_err_to_name(err));
    }
}

static int levels_learned(void)
{
    int n = 0;
    for (int c = 1; c <= LIFEFI_MAX_COUNT; c++) {
        if (s.levels.level[c].windows > 0) {
            n++;
        }
    }
    return n;
}

static void finish_learning(void)
{
    level_t *L = &s.levels.level[s.learn_target];
    L->log_motion = (float)(s.learn_log_motion / s.learn_n);
    L->active = (float)(s.learn_active / s.learn_n);
    L->windows = (uint16_t)s.learn_n;
    levels_save();
    ESP_LOGW(TAG, "learned %d people: motion %.2f, active %.0f%%", s.learn_target,
             expf(L->log_motion), L->active * 100);

    /* The mapping assumes more people -> more motion */
    const level_t *prev = NULL;
    for (int c = 1; c <= LIFEFI_MAX_COUNT; c++) {
        const level_t *cur = &s.levels.level[c];
        if (cur->windows == 0) {
            continue;
        }
        if (prev != NULL && cur->log_motion <= prev->log_motion) {
            ESP_LOGW(TAG, "learned levels do not grow with the head count (%d people <= fewer); "
                          "re-learn with everyone moving normally", c);
        }
        prev = cur;
    }
    s.learn_target = -1;
}

/* ---- calibration -------------------------------------------------------- */

static void reset_runtime(void)
{
    s.dev_smooth = -1;
    s.moving_recent = 0;
    s.still_windows = 0;
    s.last_motion_us = 0;
    s.hist_n = s.hist_i = 0;
    s.raw_n = s.raw_i = 0;
    s.count = 0;
    memset(&s.last, 0, sizeof(s.last));
}

static void start_calibration(int grace_windows)
{
    s.state = ST_CALIBRATING;
    s.cal_n = 0;
    s.warmup_left = grace_windows;
    s.learn_target = -1;
    reset_runtime();
    ESP_LOGW(TAG, "calibrating the empty room for %d s in %d s: leave the area between the "
                  "ESP32 and the router", LIFEFI_CALIB_WINDOWS, grace_windows);
}

static void finish_calibration(void)
{
    const int n = s.cal_n;
    float tmp[LIFEFI_CALIB_WINDOWS];

    /* Median variance: robust to someone briefly crossing the room */
    for (int k = 0; k < LIFEFI_NSC; k++) {
        double sum = 0;
        for (int i = 0; i < n; i++) {
            tmp[i] = s.cal_var[i][k];
            sum += s.cal_mean[i][k];
        }
        s.base_var[k] = quantile(tmp, n, 0.5f);
        s.base_mean[k] = (float)(sum / n);
    }

    /* Floor at a quarter of the median subcarrier so quiet ones can't dominate */
    float sorted[LIFEFI_NSC];
    memcpy(sorted, s.base_var, sizeof(sorted));
    float floor_var = fmaxf(0.25f * quantile(sorted, LIFEFI_NSC, 0.5f), 1e-7f);
    for (int k = 0; k < LIFEFI_NSC; k++) {
        s.base_var[k] = fmaxf(s.base_var[k], floor_var);
    }

    /* Empty-room distribution of each feature against the final baseline */
    float fm[LIFEFI_CALIB_WINDOWS], fa[LIFEFI_CALIB_WINDOWS], fd[LIFEFI_CALIB_WINDOWS];
    for (int i = 0; i < n; i++) {
        window_features(s.cal_mean[i], s.cal_var[i], &fm[i], &fa[i], &fd[i]);
    }
    float m90 = quantile(fm, n, 0.9f);
    float m_max = fm[n - 1];
    float a90 = quantile(fa, n, 0.9f);
    float d90 = quantile(fd, n, 0.9f);

    s.motion_on = fmaxf(LIFEFI_MOTION_ON_MIN, LIFEFI_MOTION_ON_SCALE * m90);
    s.active_on = fmaxf(LIFEFI_ACTIVE_ON_MIN, a90 + LIFEFI_ACTIVE_ON_MARGIN);
    s.dev_on = fmaxf(LIFEFI_DEV_ON_MIN, LIFEFI_DEV_ON_SCALE * d90);
    s.dev_off = LIFEFI_DEV_OFF_RATIO * s.dev_on;

    ESP_LOGI(TAG, "calibration done: empty motion p90 %.2f (max %.2f), active p90 %.0f%%, dev p90 %.4f",
             m90, m_max, a90 * 100, d90);
    ESP_LOGI(TAG, "thresholds: motion_on %.2f, active_on %.0f%%, dev_on %.4f",
             s.motion_on, s.active_on * 100, s.dev_on);
    if (m_max > 2.5f) {
        ESP_LOGW(TAG, "the room was not still during calibration (motion max %.2f); "
                      "type `cal` to redo it with the room empty", m_max);
    }
    s.state = ST_EMPTY;
    reset_runtime();
}

/* ---- presence and count ------------------------------------------------- */

static void set_state(state_t st, const char *why)
{
    if (st == s.state) {
        return;
    }
    ESP_LOGW(TAG, "presence: %s -> %s (%s)", STATE_NAMES[s.state], STATE_NAMES[st], why);
    s.state = st;
}

static void update_presence(int64_t now, bool moving)
{
    int recent = __builtin_popcount(s.moving_recent);
    float quiet_s = (now - s.last_motion_us) / 1e6f;

    switch (s.state) {
    case ST_EMPTY:
        if (recent >= 2) {
            set_state(ST_PRESENT, "motion");
            s.last_motion_us = now;
        } else if (s.still_windows >= STILL_ENTRY_WINDOWS) {
            set_state(ST_PRESENT, "room profile changed");
            s.last_motion_us = now;
        }
        break;
    case ST_PRESENT:
    case ST_UNCERTAIN:
        if (quiet_s >= LIFEFI_PRESENCE_HOLD_S && s.dev_smooth < s.dev_off) {
            set_state(ST_EMPTY, "no motion, profile back to empty");
        } else if (s.state == ST_PRESENT && quiet_s >= LIFEFI_UNCERTAIN_AFTER_S) {
            set_state(ST_UNCERTAIN, "no motion for a long time; type `cal` if the room is empty");
        } else if (s.state == ST_UNCERTAIN && moving) {
            set_state(ST_PRESENT, "motion");
        }
        break;
    default:
        break;
    }
}

static int estimate_count(float log_motion, float active, bool *learned)
{
    *learned = levels_learned() >= 2;
    if (*learned) {
        int best = 1;
        float best_d = INFINITY;
        for (int c = 1; c <= LIFEFI_MAX_COUNT; c++) {
            const level_t *L = &s.levels.level[c];
            if (L->windows == 0) {
                continue;
            }
            float dm = log_motion - L->log_motion;
            float da = 2.0f * (active - L->active);
            float d = dm * dm + da * da;
            if (d < best_d) {
                best_d = d;
                best = c;
            }
        }
        return best;
    }
    float score = expf(log_motion);
    if (score >= LIFEFI_COUNT4_SCORE) {
        return 4;
    }
    if (score >= LIFEFI_COUNT3_SCORE) {
        return 3;
    }
    if (score >= LIFEFI_COUNT2_SCORE) {
        return 2;
    }
    return 1;
}

static void print_status(void)
{
    ESP_LOGI(TAG, "state %s | thresholds motion_on %.2f, active_on %.0f%%, dev_on %.4f",
             STATE_NAMES[s.state], s.motion_on, s.active_on * 100, s.dev_on);
    for (int c = 1; c <= LIFEFI_MAX_COUNT; c++) {
        const level_t *L = &s.levels.level[c];
        if (L->windows > 0) {
            ESP_LOGI(TAG, "  learned %d people: motion %.2f, active %.0f%% (%u s)", c,
                     expf(L->log_motion), L->active * 100, L->windows);
        }
    }
    if (levels_learned() < 2) {
        ESP_LOGI(TAG, "  count uses default levels: score %.1f / %.1f / %.1f for 2 / 3 / 4 people; "
                      "`learn N` two or more head counts to replace them",
                 LIFEFI_COUNT2_SCORE, LIFEFI_COUNT3_SCORE, LIFEFI_COUNT4_SCORE);
    }
}

static void handle_requests(void)
{
    if (s_req_cal) {
        s_req_cal = false;
        start_calibration(CAL_GRACE_WINDOWS);
    }
    if (s_req_forget) {
        s_req_forget = false;
        memset(&s.levels, 0, sizeof(s.levels));
        levels_save();
        ESP_LOGW(TAG, "learned count levels cleared");
    }
    int learn = s_req_learn;
    if (learn >= 0) {
        s_req_learn = -1;
        if (s.state == ST_CALIBRATING) {
            ESP_LOGW(TAG, "wait for the calibration to finish before `learn`");
        } else {
            s.learn_target = learn;
            s.learn_n = 0;
            s.learn_log_motion = 0;
            s.learn_active = 0;
            ESP_LOGW(TAG, "learning %d people for %d s: everyone in the room, moving normally",
                     learn, LIFEFI_LEARN_WINDOWS);
        }
    }
    if (s_req_status) {
        s_req_status = false;
        print_status();
    }
}

/* ---- public ------------------------------------------------------------- */

void estimator_init(void)
{
    memset(&s, 0, sizeof(s));
    s.learn_target = -1;
    levels_load();
    int n = levels_learned();
    if (n > 0) {
        ESP_LOGI(TAG, "loaded %d learned count level(s) from flash", n);
    }
    start_calibration(LIFEFI_WARMUP_WINDOWS);
}

void estimator_push(const csi_window_t *w)
{
    handle_requests();
    unsigned long t = (unsigned long)(esp_timer_get_time() / 1000000);

    if (s.warmup_left > 0) {
        s.warmup_left--;
        ESP_LOGI(TAG, "t=%5lus rate=%3.0fHz starting (%d)", t, w->rate_hz, s.warmup_left);
        return;
    }
    if (w->n < LIFEFI_MIN_PACKETS) {
        ESP_LOGW(TAG, "t=%5lus only %lu CSI packets in the last second, waiting for the transmitter",
                 t, (unsigned long)w->n);
        return;
    }
    if (s.state == ST_CALIBRATING) {
        memcpy(s.cal_mean[s.cal_n], w->mean, sizeof(w->mean));
        memcpy(s.cal_var[s.cal_n], w->var, sizeof(w->var));
        s.cal_n++;
        ESP_LOGI(TAG, "t=%5lus rate=%3.0fHz rssi=%4.0f calibrating %d/%d (keep the room empty)",
                 t, w->rate_hz, w->rssi, s.cal_n, LIFEFI_CALIB_WINDOWS);
        if (s.cal_n >= LIFEFI_CALIB_WINDOWS) {
            finish_calibration();
        }
        return;
    }

    float motion, active, dev;
    window_features(w->mean, w->var, &motion, &active, &dev);
    s.dev_smooth = s.dev_smooth < 0 ? dev : 0.8f * s.dev_smooth + 0.2f * dev;

    int64_t now = esp_timer_get_time();
    bool moving = motion > s.motion_on || active > s.active_on;
    s.moving_recent = (uint8_t)(((s.moving_recent << 1) | moving) & 0x07);
    if (moving) {
        s.last_motion_us = now;
    }
    s.still_windows = s.dev_smooth > s.dev_on ? s.still_windows + 1 : 0;

    float log_motion = logf(fmaxf(motion, 1e-3f));
    s.hist_log_motion[s.hist_i] = log_motion;
    s.hist_active[s.hist_i] = active;
    s.hist_i = (s.hist_i + 1) % LIFEFI_SMOOTH_WINDOWS;
    if (s.hist_n < LIFEFI_SMOOTH_WINDOWS) {
        s.hist_n++;
    }
    float avg_log_motion = 0, avg_active = 0;
    for (int i = 0; i < s.hist_n; i++) {
        avg_log_motion += s.hist_log_motion[i];
        avg_active += s.hist_active[i];
    }
    avg_log_motion /= s.hist_n;
    avg_active /= s.hist_n;
    s.last = (estimator_features_t){
        .motion = motion, .active = active, .dev = s.dev_smooth, .score = expf(avg_log_motion),
    };

    update_presence(now, moving);

    /* Presence decides 0 vs some; the score only splits 1 / 2 / 3 / 4+ */
    bool learned = false;
    int raw = s.state == ST_EMPTY ? 0 : -1;
    if (s.state == ST_PRESENT) {
        raw = estimate_count(avg_log_motion, avg_active, &learned);
    }
    s.raw_counts[s.raw_i] = raw;
    s.raw_i = (s.raw_i + 1) % LIFEFI_COUNT_MEDIAN;
    if (s.raw_n < LIFEFI_COUNT_MEDIAN) {
        s.raw_n++;
    }
    int shown = raw;
    if (s.state == ST_PRESENT) {
        shown = median_int(s.raw_counts, s.raw_n);
        if (shown < 1) {
            shown = 1;
        }
    }
    if (shown != s.count) {
        char from[16], to[16];
        fmt_count(from, sizeof(from), s.count);
        fmt_count(to, sizeof(to), shown);
        ESP_LOGW(TAG, "people: %s -> %s", from, to);
        s.count = shown;
    }

    char learn_tag[48] = "";
    if (s.learn_target >= 0) {
        s.learn_log_motion += log_motion;
        s.learn_active += active;
        s.learn_n++;
        snprintf(learn_tag, sizeof(learn_tag), " [learn %d: %d/%d]", s.learn_target, s.learn_n,
                 LIFEFI_LEARN_WINDOWS);
    }

    char people[16];
    fmt_count(people, sizeof(people), s.count);
    ESP_LOGI(TAG, "t=%5lus rate=%3.0fHz rssi=%4.0f motion=%5.2f active=%3.0f%% dev=%.4f "
                  "score=%5.2f | %-9s people=%s%s%s",
             t, w->rate_hz, w->rssi, motion, active * 100, s.dev_smooth, expf(avg_log_motion),
             STATE_NAMES[s.state], people,
             s.state == ST_PRESENT ? (learned ? " (learned)" : " (est)") : "", learn_tag);

    if (s.learn_target >= 0 && s.learn_n >= LIFEFI_LEARN_WINDOWS) {
        finish_learning();
    }
}

int estimator_people(void)
{
    return s.state == ST_CALIBRATING ? -1 : s.count;
}

void estimator_features(estimator_features_t *out)
{
    *out = s.last;
}

void estimator_request_calibration(void)
{
    s_req_cal = true;
}

void estimator_request_learn(int count)
{
    s_req_learn = count;
}

void estimator_request_forget(void)
{
    s_req_forget = true;
}

void estimator_request_status(void)
{
    s_req_status = true;
}
