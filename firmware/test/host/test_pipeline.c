/* End to end on raw CSI. A simulated room produces int8 LLTF buffers the
 * way the ESP32 does: a multipath channel, people walking (moving reflectors),
 * per-packet AGC gain, int8 quantisation, receiver noise, a toggling
 * first_word_invalid flag, packet loss and jitter. The packets go through
 * csi_window.c and estimator.c exactly as on the device.
 *
 * The room is a model, so this checks the processing chain and the logic
 * (gain immunity, no false alarms, detection, monotonic score), not
 * real-world accuracy. */
#include <math.h>
#include <stdbool.h>
#include <string.h>
#include "csi_window.h"
#include "estimator.h"
#include "host_test.h"

#define PI       3.14159265358979
#define FC       2.437e9    /* channel 6 */
#define DF       312.5e3    /* subcarrier spacing */
#define C0       3e8
#define N_STATIC 6
#define MAX_WALK 4
#define TRIALS   6          /* random walker draws per count */

typedef struct { double amp, len; } path_t;            /* len: path length, m */
typedef struct { double amp, len0, x, v; } walker_t;   /* x: position along a 3 m track */

static path_t s_static[N_STATIC];
static walker_t s_walk[MAX_WALK];
static int s_n_walk;
static bool s_still;         /* someone standing still in the link */
static bool s_outage;        /* no packets at all */
static double s_rate_hz = 100;
static double s_loss = 0.02;

static csi_window_acc_t s_acc;
static int64_t s_win_start;

/* ---- the room ----------------------------------------------------------- */

static void room_init(void)
{
    s_static[0] = (path_t){ 1.0, 4.0 };   /* line of sight, 4 m */
    for (int p = 1; p < N_STATIC; p++) {
        s_static[p] = (path_t){ 0.1 + 0.3 * host_frand(), 6.0 + 12.0 * host_frand() };
    }
}

static void set_walkers(int n)
{
    s_n_walk = n;
    for (int i = 0; i < n; i++) {
        s_walk[i] = (walker_t){
            .amp = 0.15 + 0.15 * host_frand(),
            .len0 = 5.0 + 6.0 * host_frand(),
            .x = 3.0 * host_frand(),
            .v = (host_frand() < 0.5f ? -1 : 1) * (0.6 + 0.8 * host_frand()),
        };
    }
}

static void step_walkers(double dt)
{
    for (int i = 0; i < s_n_walk; i++) {
        walker_t *w = &s_walk[i];
        w->x += w->v * dt;
        if (w->x < 0 || w->x > 3.0) {
            w->v = -w->v;
            w->x = w->x < 0 ? 0 : 3.0;
        }
    }
}

static void add_path(double amp, double len, double f, double *re, double *im)
{
    double ph = -2 * PI * f * len / C0;
    *re += amp * cos(ph);
    *im += amp * sin(ph);
}

static void channel(int k, double *re, double *im)
{
    double f = FC + k * DF;
    *re = *im = 0;
    for (int p = 0; p < N_STATIC; p++) {
        add_path(s_static[p].amp, s_static[p].len, f, re, im);
    }
    for (int i = 0; i < s_n_walk; i++) {   /* a reflection: moving x metres changes the path ~2x */
        add_path(s_walk[i].amp, s_walk[i].len0 + 2 * s_walk[i].x, f, re, im);
    }
    if (s_still) {
        add_path(0.3, 6.3, f, re, im);
    }
}

static int8_t q8(double v)
{
    long r = lrint(v + 0.7 * host_gauss());   /* receiver noise, then int8 */
    return (int8_t)(r > 127 ? 127 : r < -128 ? -128 : r);
}

static void make_packet(csi_packet_t *p)
{
    memset(p, 0, sizeof(*p));
    double gain = 20.0 * (0.6 + 0.8 * host_frand());   /* per-packet AGC / auto-scale */
    for (int k = -26; k <= 26; k++) {
        if (k == 0) {
            continue;
        }
        double re, im;
        channel(k, &re, &im);
        int j = k >= 0 ? k : k + 64;
        p->buf[2 * j] = q8(gain * im);
        p->buf[2 * j + 1] = q8(gain * re);
    }
    p->rssi = -50;
    p->first_word_invalid = host_frand() < 0.3f;
    if (p->first_word_invalid) {   /* the hardware leaves garbage there */
        p->buf[2] = (int8_t)(host_frand() * 200 - 100);
        p->buf[3] = (int8_t)(host_frand() * 200 - 100);
    }
}

/* Run the room, closing a 1 s window and pushing it like csi_task() does */
static void run(double seconds)
{
    int64_t end = host_now_us + (int64_t)(seconds * 1e6);
    while (host_now_us < end) {
        double dt = (1.0 / s_rate_hz) * (0.7 + 0.6 * host_frand());
        host_now_us += (int64_t)(dt * 1e6);
        step_walkers(dt);
        if (!s_outage && host_frand() >= s_loss) {
            csi_packet_t p;
            make_packet(&p);
            csi_window_add(&s_acc, &p);
        }
        if (host_now_us - s_win_start >= LIFEFI_WINDOW_MS * 1000LL) {
            csi_window_t w;
            csi_window_close(&s_acc, host_now_us - s_win_start, &w);
            s_win_start = host_now_us;
            estimator_push(&w);
        }
    }
}

/* Run and count seconds where people != expected */
static int run_count_wrong(double seconds, int expected)
{
    int wrong = 0;
    for (int i = 0; i < (int)seconds; i++) {
        run(1);
        wrong += estimator_people() != expected;
    }
    return wrong;
}

/* Run and return the mean score over the last `tail` seconds */
static float run_mean_score(double seconds, int tail)
{
    run(seconds - tail);
    float sum = 0;
    for (int i = 0; i < tail; i++) {
        run(1);
        estimator_features_t f;
        estimator_features(&f);
        sum += f.score;
    }
    return sum / tail;
}

static int seconds_until_present(int max_s)
{
    for (int i = 1; i <= max_s; i++) {
        run(1);
        if (estimator_people() >= 1) {
            return i;
        }
    }
    return -1;
}

/* ---- scenarios -------------------------------------------------------- */

static void calibrate(void)
{
    run(LIFEFI_WARMUP_WINDOWS + LIFEFI_CALIB_WINDOWS + 0.5);
}

int main(int argc, char **argv)
{
    host_init(argc, argv, 2026);
    room_init();
    estimator_init();

    printf("== boot calibration on raw CSI (AGC jumps, int8, noise, 2%% loss)\n");
    calibrate();
    CHECK(estimator_people() == 0, "calibrated, room empty");

    printf("== empty room, 5 min\n");
    int fp = run_count_wrong(300, 0);
    CHECK(fp == 0, "no false presence in 5 min (%d s wrong)", fp);

    printf("== one person walking\n");
    set_walkers(1);
    int t1 = seconds_until_present(5);
    CHECK(t1 > 0 && t1 <= 4, "detected after %d s", t1);
    run(25);

    printf("== they leave\n");
    set_walkers(0);
    run(25);
    CHECK(estimator_people() >= 1, "held 25 s after leaving");
    run(15);
    CHECK(estimator_people() == 0, "empty 40 s after leaving");

    printf("== someone stands still in the link\n");
    s_still = true;
    int t_still = seconds_until_present(20);
    CHECK(t_still > 0, "still person detected after %d s (profile change)", t_still);
    int lost = run_count_wrong(120, estimator_people());
    CHECK(lost == 0 && estimator_people() >= 1, "held for 2 min while still (%d s changed)", lost);
    s_still = false;
    run(50);
    CHECK(estimator_people() == 0, "empty 50 s after they leave");

    /* Each walker gets a random reflection strength (0.15-0.3) and path,
     * like people at different distances from the link. The score measures
     * total fluctuation, so one strong walker can match two weak ones: only
     * the average over many draws has to grow with the count. */
    printf("== activity score vs number of walkers (%d draws each)\n", TRIALS);
    float score[4] = { 0 };
    for (int trial = 0; trial < TRIALS; trial++) {
        for (int n = 1; n <= 3; n++) {
            set_walkers(n);
            score[n] += run_mean_score(20, 10) / TRIALS;
        }
    }
    printf("  mean score: 1 walker %.2f, 2 walkers %.2f, 3 walkers %.2f\n", score[1], score[2], score[3]);
    CHECK(score[1] < score[3], "3 walkers score higher than 1 on average");
    CHECK(score[1] > 1.5f, "1 walker clearly above the empty room (~1.0)");
    set_walkers(0);
    run(60);

    printf("== learn 1 / 2 / 3, then count fresh walkers (%d draws each)\n", TRIALS);
    for (int n = 1; n <= 3; n++) {
        set_walkers(n);
        run(10);
        estimator_request_learn(n);
        run(LIFEFI_LEARN_WINDOWS + 1);
    }
    int confusion[4][4] = { { 0 } };
    float reported[4] = { 0 };
    for (int trial = 0; trial < TRIALS; trial++) {
        for (int n = 1; n <= 3; n++) {
            set_walkers(n);
            run(25);
            int got = estimator_people();
            confusion[n][got >= 1 && got <= 3 ? got : 0]++;
            reported[n] += (float)got / TRIALS;
        }
    }
    printf("  true\\got   1  2  3  other   mean\n");
    int other = 0, exact = 0;
    for (int n = 1; n <= 3; n++) {
        printf("  %d         %2d %2d %2d %2d      %.2f\n", n, confusion[n][1], confusion[n][2],
               confusion[n][3], confusion[n][0], reported[n]);
        other += confusion[n][0];
        exact += confusion[n][n];
    }
    printf("  exact %d/%d: one link gives a coarse count (see csi-people-counting.md)\n", exact,
           3 * TRIALS);
    CHECK(other == 0, "always a count of 1-3 while people move (never 0 or ?)");
    CHECK(reported[1] < reported[3], "3 walkers read higher than 1 on average");
    set_walkers(0);
    run(60);
    CHECK(estimator_people() == 0, "empty again");

    printf("== 5 s with no packets at all\n");
    s_outage = true;
    run(5);
    s_outage = false;
    fp = run_count_wrong(20, 0);
    CHECK(fp == 0, "no false presence around the outage (%d s wrong)", fp);

    printf("== sniffer-like 15 Hz after recalibrating\n");
    s_rate_hz = 15;
    estimator_request_calibration();
    run(10 + LIFEFI_CALIB_WINDOWS + 1.5);
    CHECK(estimator_people() == 0, "recalibrated at 15 Hz");
    fp = run_count_wrong(180, 0);
    CHECK(fp == 0, "no false presence in 3 min at 15 Hz (%d s wrong)", fp);
    set_walkers(1);
    int t15 = seconds_until_present(10);
    CHECK(t15 > 0 && t15 <= 5, "walker detected at 15 Hz after %d s", t15);

    return host_finish("test_pipeline");
}
