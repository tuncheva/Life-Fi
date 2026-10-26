/* commands.c: parsing of typed lines and their effect on the estimator. */
#include <string.h>
#include "commands.h"
#include "estimator.h"
#include "host_test.h"

static float s_profile[LIFEFI_NSC];

static void push_quiet(int seconds)
{
    for (int i = 0; i < seconds; i++) {
        csi_window_t w;
        w.n = 100;
        w.rate_hz = 100;
        w.rssi = -50;
        for (int k = 0; k < LIFEFI_NSC; k++) {
            w.mean[k] = s_profile[k] + 0.002f * host_gauss();
            w.var[k] = 1e-4f * (0.7f + 0.6f * host_frand());
        }
        host_now_us += 1000000;
        estimator_push(&w);
    }
}

static void type(const char *text)
{
    char line[64];
    strncpy(line, text, sizeof(line) - 1);
    line[sizeof(line) - 1] = '\0';
    printf("  > %s\n", text);
    commands_handle_line(line);
}

int main(int argc, char **argv)
{
    host_init(argc, argv, 7);
    for (int k = 0; k < LIFEFI_NSC; k++) {
        s_profile[k] = 1.0f + 0.3f * host_gauss();
    }
    estimator_init();
    push_quiet(LIFEFI_WARMUP_WINDOWS + LIFEFI_CALIB_WINDOWS);
    CHECK(estimator_people() == 0, "calibrated");

    printf("== ignored input\n");
    int writes = host_nvs_writes;
    type("");
    type("   \t ");
    type("bogus");
    type("learn");
    type("learn 0");
    type("learn 9");
    type("help");
    type("status");
    push_quiet(LIFEFI_LEARN_WINDOWS + 1);
    CHECK(host_nvs_writes == writes, "nothing learned or saved (writes %d -> %d)", writes, host_nvs_writes);
    CHECK(estimator_people() == 0, "state unchanged");

    printf("== learn N\n");
    type("  LEARN 2 \r");
    push_quiet(LIFEFI_LEARN_WINDOWS - 1);
    CHECK(host_nvs_writes == writes, "not saved before %d s", LIFEFI_LEARN_WINDOWS);
    push_quiet(2);
    CHECK(host_nvs_writes == writes + 1, "saved after %d s (case and spaces ignored)", LIFEFI_LEARN_WINDOWS);

    printf("== forget\n");
    type("forget");
    push_quiet(1);
    CHECK(host_nvs_writes == writes + 2, "forget saves the cleared levels");

    printf("== cal\n");
    type("cal");
    push_quiet(1);
    CHECK(estimator_people() == -1, "cal restarts calibration");
    type("learn 1");
    push_quiet(1);
    push_quiet(10 + LIFEFI_CALIB_WINDOWS);
    CHECK(host_nvs_writes == writes + 2, "learn is refused while calibrating");
    CHECK(estimator_people() == 0, "calibrated again after grace + %d s", LIFEFI_CALIB_WINDOWS);

    return host_finish("test_commands");
}
