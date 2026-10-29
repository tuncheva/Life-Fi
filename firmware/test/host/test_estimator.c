/* estimator.c on synthetic 1 s windows: calibration, presence (moving and
 * still), leaving, UNCERTAIN, sparse windows, learned counts and their NVS
 * persistence. */
#include <math.h>
#include <string.h>
#include "estimator.h"
#include "host_test.h"

static float s_profile[LIFEFI_NSC];   /* empty-room mean amplitude profile */
static float s_base_var[LIFEFI_NSC];  /* empty-room variance per subcarrier */
static float s_still[LIFEFI_NSC];     /* profile change from one person standing still */

static void room_init(void)
{
    for (int k = 0; k < LIFEFI_NSC; k++) {
        s_profile[k] = 1.0f + 0.3f * host_gauss();
        s_base_var[k] = 1e-4f * (0.5f + host_frand());
        s_still[k] = 0.05f * host_gauss();
    }
}

/* Each mover raises the variance of ~60 % of the subcarriers 6-20x */
static void push_window(int moving, int still, uint32_t packets)
{
    csi_window_t w;
    w.n = packets;
    w.rate_hz = (float)packets;
    w.rssi = -50;
    for (int k = 0; k < LIFEFI_NSC; k++) {
        float v = s_base_var[k] * (0.7f + 0.6f * host_frand());
        float m = s_profile[k] + 0.002f * host_gauss();
        for (int p = 0; p < moving; p++) {
            if (host_frand() < 0.6f) {
                v += s_base_var[k] * (6.0f + 14.0f * host_frand());
            }
            m += 0.03f * host_gauss();
        }
        if (still) {
            m += s_still[k];
        }
        w.mean[k] = m;
        w.var[k] = v;
    }
    host_now_us += 1000000;
    estimator_push(&w);
}

static void run(int seconds, int moving, int still)
{
    for (int i = 0; i < seconds; i++) {
        push_window(moving, still, 100);
    }
}

static void calibrate(void)
{
    run(LIFEFI_WARMUP_WINDOWS + LIFEFI_CALIB_WINDOWS, 0, 0);
}

int main(int argc, char **argv)
{
    host_init(argc, argv, 12345);
    room_init();

    printf("== boot calibration\n");
    estimator_init();
    CHECK(estimator_people() == -1, "calibrating at boot");
    calibrate();
    CHECK(estimator_people() == 0, "empty after calibration");

    printf("== empty room, 10 min\n");
    int false_present = 0;
    for (int i = 0; i < 600; i++) {
        push_window(0, 0, 100);
        false_present += estimator_people() != 0;
    }
    CHECK(false_present == 0, "no false presence in 10 min (%d s)", false_present);

    printf("== one person walks in\n");
    run(3, 1, 0);
    CHECK(estimator_people() >= 1, "present within 3 s of motion");
    run(20, 1, 0);
    CHECK(estimator_people() >= 1, "still present while moving");

    printf("== person leaves\n");
    run(20, 0, 0);
    CHECK(estimator_people() >= 1, "held for 20 s after motion stops");
    run(15, 0, 0);
    CHECK(estimator_people() == 0, "empty 35 s after leaving");

    printf("== person stands still in the link\n");
    run(12, 0, 1);
    CHECK(estimator_people() >= 1, "still person detected from the profile");
    run(120, 0, 1);
    CHECK(estimator_people() >= 1, "still person held for 2 min");
    run(45, 0, 0);
    CHECK(estimator_people() == 0, "empty after the still person leaves");

    printf("== no motion for 5 min with the profile still changed\n");
    run(12, 0, 1);
    run(LIFEFI_UNCERTAIN_AFTER_S, 0, 1);
    CHECK(estimator_people() == -1, "UNCERTAIN after %d s without motion", LIFEFI_UNCERTAIN_AFTER_S);
    run(3, 1, 1);
    CHECK(estimator_people() >= 1, "motion brings it back to PRESENT");
    run(45, 0, 0);
    CHECK(estimator_people() == 0, "empty after leaving");

    printf("== sparse windows (transmitter gone)\n");
    for (int i = 0; i < 10; i++) {
        push_window(1, 0, LIFEFI_MIN_PACKETS - 1);
    }
    CHECK(estimator_people() == 0, "windows with < %d packets are ignored, even with motion",
          LIFEFI_MIN_PACKETS);

    printf("== learn 1 / 2 / 3 people\n");
    estimator_request_learn(1);
    run(LIFEFI_LEARN_WINDOWS, 1, 0);
    estimator_request_learn(2);
    run(LIFEFI_LEARN_WINDOWS, 2, 0);
    estimator_request_learn(3);
    run(LIFEFI_LEARN_WINDOWS, 3, 0);
    estimator_request_status();
    run(1, 3, 0);

    printf("== learned counts\n");
    run(20, 2, 0);
    CHECK(estimator_people() == 2, "2 people moving -> 2 (got %d)", estimator_people());
    run(20, 1, 0);
    CHECK(estimator_people() == 1, "1 person moving -> 1 (got %d)", estimator_people());
    run(20, 3, 0);
    CHECK(estimator_people() == 3, "3 people moving -> 3 (got %d)", estimator_people());

    printf("== reboot: levels come back from flash\n");
    estimator_init();
    calibrate();
    run(20, 2, 0);
    CHECK(estimator_people() == 2, "2 people after reboot -> 2 (got %d)", estimator_people());

    printf("== forget\n");
    estimator_request_forget();
    run(20, 2, 0);
    CHECK(estimator_people() >= 1, "default levels after forget");

    return host_finish("test_estimator");
}
