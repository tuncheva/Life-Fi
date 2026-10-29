#include "stream.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "lwip/sockets.h"
#include "csi_frame.h"
#include "lifefi_config.h"

static const char *TAG = "stream";

static int s_sock = -1;
static struct sockaddr_in s_sub;
static bool s_have_sub;
static int64_t s_sub_seen_us;
static uint32_t s_boot_id;
static uint32_t s_seq;
static uint32_t s_sent;
static uint32_t s_send_errors;
static volatile int64_t s_usb_until_us;
static uint32_t s_usb_sent;

static uint32_t boot_id(void)
{
    while (s_boot_id == 0) {
        s_boot_id = esp_random();
    }
    return s_boot_id;
}

void stream_usb_keepalive(void)
{
    bool was_on = s_usb_until_us > esp_timer_get_time();
    s_usb_until_us = esp_timer_get_time() + LIFEFI_STREAM_TIMEOUT_MS * 1000LL;
    if (!was_on) {
        ESP_LOGI(TAG, "streaming raw CSI over USB as \"" CSI_LINE_PREFIX "...\" lines");
    }
}

void stream_start(void)
{
    if (s_sock >= 0) {
        return;
    }
    boot_id();
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket failed: errno %d", errno);
        return;
    }
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(LIFEFI_STREAM_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "bind to port %d failed: errno %d", LIFEFI_STREAM_PORT, errno);
        close(sock);
        return;
    }
    fcntl(sock, F_SETFL, O_NONBLOCK);
    s_sock = sock;
    ESP_LOGI(TAG, "raw CSI stream ready on UDP port %d (run tools/csi_recorder.py on the PC)",
             LIFEFI_STREAM_PORT);
}

void stream_poll(void)
{
    if (s_sock < 0) {
        return;
    }
    int64_t now = esp_timer_get_time();
    char msg[16];
    struct sockaddr_in from;
    socklen_t from_len = sizeof(from);
    int n;
    while ((n = recvfrom(s_sock, msg, sizeof(msg), 0, (struct sockaddr *)&from, &from_len)) > 0) {
        if (n >= 5 && memcmp(msg, "LFSUB", 5) == 0) {
            bool changed = !s_have_sub || from.sin_addr.s_addr != s_sub.sin_addr.s_addr ||
                           from.sin_port != s_sub.sin_port;
            s_sub = from;
            s_have_sub = true;
            s_sub_seen_us = now;
            if (changed) {
                ESP_LOGI(TAG, "streaming raw CSI to %s:%d", inet_ntoa(from.sin_addr),
                         ntohs(from.sin_port));
            }
        }
        from_len = sizeof(from);
    }
    if (s_have_sub && now - s_sub_seen_us > LIFEFI_STREAM_TIMEOUT_MS * 1000LL) {
        s_have_sub = false;
        ESP_LOGI(TAG, "stream stopped: no subscription for %d s", LIFEFI_STREAM_TIMEOUT_MS / 1000);
    }
}

void stream_send(const csi_packet_t *p)
{
    bool usb = s_usb_until_us > esp_timer_get_time();
    if (!s_have_sub && !usb) {
        return;
    }
    /* One caller (the CSI task): static buffers keep its stack small */
    static uint8_t frame[CSI_FRAME_MAX];
    static char line[CSI_LINE_MAX];
    size_t len = csi_frame_build(frame, sizeof(frame), p, LIFEFI_NODE_ID, boot_id(), s_seq++);
    if (len == 0) {
        return;
    }
    if (s_have_sub) {
        if (sendto(s_sock, frame, len, 0, (struct sockaddr *)&s_sub, sizeof(s_sub)) < 0) {
            s_send_errors++;
        } else {
            s_sent++;
        }
    }
    /* Through stdout, so the line never interleaves with log lines */
    if (usb && csi_frame_line(line, sizeof(line), frame, len) > 0) {
        fputs(line, stdout);
        s_usb_sent++;
    }
}

void stream_describe(char *buf, size_t len)
{
    char usb[32] = "";
    if (s_usb_until_us > esp_timer_get_time()) {
        snprintf(usb, sizeof(usb), ", usb %lu sent", (unsigned long)s_usb_sent);
    }
    if (s_sock < 0) {
        snprintf(buf, len, "udp stream off (no Wi-Fi)%s", usb);
    } else if (!s_have_sub) {
        snprintf(buf, len, "udp stream idle%s", usb);
    } else {
        snprintf(buf, len, "stream -> %s:%d, %lu sent, %lu errors%s", inet_ntoa(s_sub.sin_addr),
                 ntohs(s_sub.sin_port), (unsigned long)s_sent, (unsigned long)s_send_errors, usb);
    }
}
