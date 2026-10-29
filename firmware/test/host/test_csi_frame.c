/* csi_frame.c: the wire format of the raw CSI stream. Writes frame_sample.bin,
 * which check_csi_frame.py then parses with tools/csi_recorder.py, so the C
 * and Python sides of the contract are checked against each other. */
#include <stddef.h>
#include <string.h>
#include "csi_frame.h"
#include "host_test.h"

static csi_packet_t sample_packet(uint16_t len)
{
    csi_packet_t p;
    memset(&p, 0, sizeof(p));
    p.ts_us = 0x0102030405060708LL;
    const uint8_t mac[6] = { 0xf0, 0x33, 0xe5, 0x66, 0x52, 0xb0 };
    memcpy(p.mac, mac, 6);
    p.rssi = -67;
    p.noise_floor = -95;
    p.sig_mode = 1;
    p.mcs = 7;
    p.channel = 8;
    p.first_word_invalid = true;
    p.rx_seq = 4321;
    p.len = len;
    for (int i = 0; i < len; i++) {
        p.buf[i] = (int8_t)(i - 128);
    }
    return p;
}

int main(int argc, char **argv)
{
    host_init(argc, argv, 1);

    printf("== header layout\n");
    CHECK(sizeof(csi_frame_hdr_t) == 54, "header is 54 bytes");
    CHECK(offsetof(csi_frame_hdr_t, src_mac) == 22 && offsetof(csi_frame_hdr_t, gain_comp) == 32 &&
          offsetof(csi_frame_hdr_t, ts_us) == 40 && offsetof(csi_frame_hdr_t, n_values) == 52,
          "field offsets match plan-v2 §4.1");

    printf("== build\n");
    csi_packet_t ht = sample_packet(256);
    uint8_t frame[CSI_FRAME_MAX];
    size_t len = csi_frame_build(frame, sizeof(frame), &ht, 1, 0xCAFEBABE, 77);
    CHECK(len == 54 + 256, "HT frame is header + 256 bytes (%u)", (unsigned)len);
    csi_frame_hdr_t h;
    memcpy(&h, frame, sizeof(h));
    CHECK(h.magic == CSI_MAGIC && h.version == 2 && h.hdr_len == 54, "magic, version, hdr_len");
    CHECK(h.csi_parts == (CSI_PART_LLTF | CSI_PART_HTLTF), "LLTF + HT-LTF flagged");
    CHECK(h.rssi_dbm == -67 && h.channel == 8 && h.rx_seq == 4321 && h.seq == 77 &&
          h.boot_id == 0xCAFEBABE && h.ts_us == 0x0102030405060708ULL, "metadata copied");
    CHECK(memcmp(frame + 54, ht.buf, 256) == 0, "CSI bytes unmodified");

    csi_packet_t legacy = sample_packet(128);
    len = csi_frame_build(frame, sizeof(frame), &legacy, 1, 1, 0);
    memcpy(&h, frame, sizeof(h));
    CHECK(len == 54 + 128 && h.csi_parts == CSI_PART_LLTF && h.n_values == 128, "non-HT frame: LLTF only");
    CHECK(csi_frame_build(frame, 100, &ht, 1, 1, 0) == 0, "refuses a too-small buffer");

    printf("== USB line (base64)\n");
    const uint8_t abc[] = { 'M', 'a', 'n', 'M', 'a' };
    char line[CSI_LINE_MAX];
    size_t n = csi_frame_line(line, sizeof(line), abc, 3);
    CHECK(n == 10 && strcmp(line, "@CSI TWFu\n") == 0, "3 bytes -> \"TWFu\" (%s)", line);
    csi_frame_line(line, sizeof(line), abc, 5);
    CHECK(strcmp(line, "@CSI TWFuTWE=\n") == 0, "5 bytes padded with = (%s)", line);
    csi_frame_line(line, sizeof(line), abc, 4);
    CHECK(strcmp(line, "@CSI TWFuTQ==\n") == 0, "4 bytes padded with == (%s)", line);
    CHECK(csi_frame_line(line, 8, abc, 5) == 0, "refuses a too-small buffer");
    len = csi_frame_build(frame, sizeof(frame), &ht, 1, 0xCAFEBABE, 77);
    n = csi_frame_line(line, sizeof(line), frame, len);
    CHECK(n > 0 && n < sizeof(line) && strchr(line, '\n') == line + n - 1,
          "a full HT frame fits CSI_LINE_MAX as one line (%u chars)", (unsigned)n);

    /* For check_csi_frame.py */
    FILE *f = fopen("frame_sample.bin", "wb");
    CHECK(f != NULL && fwrite(frame, 1, len, f) == len, "wrote frame_sample.bin");
    if (f != NULL) {
        fclose(f);
    }
    f = fopen("frame_line.txt", "wb");
    CHECK(f != NULL && fwrite(line, 1, n, f) == n, "wrote frame_line.txt");
    if (f != NULL) {
        fclose(f);
    }
    return host_finish("test_csi_frame");
}
