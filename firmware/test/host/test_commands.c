/* commands.c: parsing of typed lines and their effect on the estimator and
 * on the stored Wi-Fi credentials. */
#include <string.h>
#include "commands.h"
#include "esp_system.h"
#include "estimator.h"
#include "host_test.h"
#include "stream.h"
#include "wifi_link.h"

static float s_profile[LIFEFI_NSC];

/* ---- stubs for the Wi-Fi side ------------------------------------------- */

static int s_saves, s_restarts, s_usb_keepalives;

void stream_usb_keepalive(void)
{
    s_usb_keepalives++;
}
static char s_saved_ssid[40], s_saved_pass[80];

esp_err_t wifi_link_save_credentials(const char *ssid, const char *password)
{
    s_saves++;
    strcpy(s_saved_ssid, ssid ? ssid : "(cleared)");
    strcpy(s_saved_pass, password ? password : "");
    return ESP_OK;
}

void esp_restart(void)
{
    s_restarts++;
}

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
    char line[128];
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

    printf("== wifi\n");
    type("wifi");
    type("wifi Net short");
    type("wifi \"unterminated");
    type("wifi 123456789012345678901234567890123 password1");
    CHECK(s_saves == 0 && s_restarts == 0, "bad wifi lines save nothing and don't restart");

    type("WIFI MyNet S3cret Pass");
    CHECK(s_saves == 1 && s_restarts == 1, "wifi saves and restarts");
    CHECK(strcmp(s_saved_ssid, "MyNet") == 0, "SSID case kept (\"%s\")", s_saved_ssid);
    CHECK(strcmp(s_saved_pass, "S3cret Pass") == 0, "password is the rest of the line (\"%s\")",
          s_saved_pass);

    type("  wifi   \"Home Net 2\"   p@ss w0rd!  ");
    CHECK(strcmp(s_saved_ssid, "Home Net 2") == 0, "quoted SSID with spaces (\"%s\")", s_saved_ssid);
    CHECK(strcmp(s_saved_pass, "p@ss w0rd!") == 0, "password trimmed at the ends (\"%s\")", s_saved_pass);

    type("wifi OpenCafe");
    CHECK(s_saves == 3 && s_saved_pass[0] == '\0', "no password = open network");

    type("wifi clear");
    CHECK(s_saves == 4 && strcmp(s_saved_ssid, "(cleared)") == 0 && s_restarts == 4,
          "wifi clear erases and restarts");
    type("wifi \"clear\" password1");
    CHECK(strcmp(s_saved_ssid, "clear") == 0, "a network literally named \"clear\" can be quoted");

    printf("== usbstream\n");
    type("usbstream");
    type("USBSTREAM\r");
    CHECK(s_usb_keepalives == 2, "usbstream keeps the USB stream alive (%d)", s_usb_keepalives);

    return host_finish("test_commands");
}
